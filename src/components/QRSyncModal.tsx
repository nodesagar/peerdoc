import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import * as Y from 'yjs';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { QrCode, Camera, ArrowLeftRight, Check, AlertCircle, X } from 'lucide-react';
import {
  buildFrames,
  FrameCollector,
  computeDocStateHash,
  MAX_QR_FRAMES,
} from '../lib/crdt/qrSync';

interface QRSyncModalProps {
  isOpen: boolean;
  onClose: () => void;
  doc: Y.Doc | null;
  documentId: string | null;
}

type TabMode = 'send' | 'receive';

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export const QRSyncModal: React.FC<QRSyncModalProps> = ({
  isOpen,
  onClose,
  doc,
  documentId,
}) => {
  const [tab, setTab] = useState<TabMode>('send');

  // Send state
  const [frames, setFrames] = useState<string[]>([]);
  const [frameIndex, setFrameIndex] = useState(0);
  const [updateByteLength, setUpdateByteLength] = useState(0);
  const [sendError, setSendError] = useState<string | null>(null);
  const [stateHash, setStateHash] = useState<string>('');
  const qrCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Receive state
  const [receivedCount, setReceivedCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [progress, setProgress] = useState(0);
  const [mergedHash, setMergedHash] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [scanHint, setScanHint] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scanCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const collectorRef = useRef<FrameCollector | null>(null);
  const finishingRef = useRef(false);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  // Close & cleanup when modal closes
  useEffect(() => {
    if (!isOpen) {
      stopCamera();
      setTab('send');
      setFrames([]);
      setFrameIndex(0);
      setReceivedCount(0);
      setTotalCount(0);
      setProgress(0);
      setMergedHash(null);
      setCameraError(null);
      setScanHint(null);
      setSendError(null);
    }
  }, [isOpen, stopCamera]);

  // Build frames whenever modal is open on the Send tab
  useEffect(() => {
    if (!isOpen || tab !== 'send' || !doc || !documentId) return;

    let cancelled = false;
    setSendError(null);

    (async () => {
      try {
        const rawUpdate = Y.encodeStateAsUpdate(doc);
        const built = await buildFrames(doc, documentId);
        const hash = await computeDocStateHash(doc);
        if (cancelled) return;
        setUpdateByteLength(rawUpdate.byteLength);
        setFrames(built);
        setFrameIndex(0);
        setStateHash(hash);
      } catch (err) {
        if (cancelled) return;
        setSendError(err instanceof Error ? err.message : 'Could not build QR frames');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen, tab, doc, documentId]);

  // Cycle frames at ~4 fps (250 ms) on the Send tab
  useEffect(() => {
    if (!isOpen || tab !== 'send' || frames.length <= 1 || frames.length > MAX_QR_FRAMES) {
      return;
    }
    const timer = window.setInterval(() => {
      setFrameIndex((prev) => (prev + 1) % frames.length);
    }, 250);
    return () => window.clearInterval(timer);
  }, [isOpen, tab, frames]);

  // Render current QR frame onto canvas
  useEffect(() => {
    if (!isOpen || tab !== 'send' || frames.length === 0 || frames.length > MAX_QR_FRAMES) {
      return;
    }
    const canvas = qrCanvasRef.current;
    const frame = frames[frameIndex] ?? frames[0];
    if (!canvas || !frame) return;

    QRCode.toCanvas(canvas, frame, {
      errorCorrectionLevel: 'L',
      width: 240,
      margin: 2,
      color: {
        dark: '#141413',
        light: '#FFFFFF',
      },
    }).catch((err) => {
      console.error('QR render error:', err);
    });
  }, [isOpen, tab, frames, frameIndex]);

  // Manage camera & 150 ms jsQR scan loop on the Receive tab
  useEffect(() => {
    if (!isOpen || tab !== 'receive' || !doc || !documentId) {
      stopCamera();
      return;
    }

    let cancelled = false;
    let scanTimer: number | null = null;
    finishingRef.current = false;
    collectorRef.current = new FrameCollector(documentId);
    setReceivedCount(0);
    setTotalCount(0);
    setProgress(0);
    setMergedHash(null);
    setCameraError(null);
    setScanHint(null);

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraError(
        'Camera access is unavailable in this browser context. Make sure you are on HTTPS or localhost.'
      );
      return;
    }

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }

        scanTimer = window.setInterval(async () => {
          if (cancelled || finishingRef.current) return;
          const video = videoRef.current;
          const canvas = scanCanvasRef.current;
          const collector = collectorRef.current;
          if (!video || !canvas || !collector) return;
          if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth === 0) {
            return;
          }

          const width = video.videoWidth;
          const height = video.videoHeight;
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (!ctx) return;

          ctx.drawImage(video, 0, 0, width, height);
          const imageData = ctx.getImageData(0, 0, width, height);
          const code = jsQR(imageData.data, width, height, {
            inversionAttempts: 'dontInvert',
          });

          if (!code || !code.data) return;

          const res = collector.add(code.data);
          if (res.error) {
            setScanHint(res.error);
            return;
          }

          setScanHint(null);
          setReceivedCount(res.received);
          setTotalCount(res.total);
          setProgress(res.progress);

          if (res.complete) {
            finishingRef.current = true;
            if (scanTimer !== null) {
              window.clearInterval(scanTimer);
              scanTimer = null;
            }
            stopCamera();
            try {
              const updateBytes = await collector.finish();
              Y.applyUpdate(doc, updateBytes, 'qr');
              const hash = await computeDocStateHash(doc);
              if (!cancelled) {
                setMergedHash(hash);
                setStateHash(hash);
              }
            } catch (err) {
              if (!cancelled) {
                setScanHint(
                  err instanceof Error ? err.message : 'Failed to decode QR sync payload'
                );
                collector.reset();
                finishingRef.current = false;
              }
            }
          }
        }, 150);
      } catch (err) {
        if (cancelled) return;
        const isDenied =
          err instanceof DOMException &&
          (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError');
        setCameraError(
          isDenied
            ? 'Camera permission was denied. Allow camera access in your browser address bar and try again.'
            : 'Could not access a camera on this device. Make sure a camera is connected and you are using HTTPS or localhost.'
        );
      }
    })();

    return () => {
      cancelled = true;
      if (scanTimer !== null) {
        window.clearInterval(scanTimer);
      }
      stopCamera();
    };
  }, [isOpen, tab, doc, documentId, stopCamera]);

  if (!isOpen || !doc || !documentId) return null;

  const handleSwapRoles = () => {
    stopCamera();
    setTab((prev) => (prev === 'send' ? 'receive' : 'send'));
  };

  const tooLargeForQR = frames.length > MAX_QR_FRAMES;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="qr-sync-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-ink/40 backdrop-blur-xs overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="my-auto bg-white rounded-3xl max-w-md w-full max-h-[calc(100vh-2rem)] overflow-y-auto shadow-xl p-5 sm:p-6 space-y-4 ring-1 ring-ink/10"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="w-8 h-8 rounded-xl bg-mint text-ink flex items-center justify-center shrink-0">
                <QrCode className="w-4 h-4" />
              </span>
              <h2 id="qr-sync-title" className="font-serif text-subheading text-ink">
                Sync via QR
              </h2>
            </div>
            <p className="text-caption text-graphite mt-1">
              Merge edits offline with another device that has this document open.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="btn btn-ghost h-8 w-8 px-0 -mr-1 -mt-1 shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Send / Receive Tabs */}
        <div className="grid grid-cols-2 gap-1.5 p-1 rounded-2xl bg-linen">
          <button
            type="button"
            onClick={() => setTab('send')}
            className={`h-9 rounded-xl text-caption font-medium flex items-center justify-center gap-1.5 transition-colors ${
              tab === 'send' ? 'bg-white text-ink shadow-xs' : 'text-graphite hover:text-ink'
            }`}
          >
            <QrCode className="w-3.5 h-3.5" />
            <span>Send</span>
          </button>
          <button
            type="button"
            onClick={() => setTab('receive')}
            className={`h-9 rounded-xl text-caption font-medium flex items-center justify-center gap-1.5 transition-colors ${
              tab === 'receive' ? 'bg-white text-ink shadow-xs' : 'text-graphite hover:text-ink'
            }`}
          >
            <Camera className="w-3.5 h-3.5" />
            <span>Receive</span>
          </button>
        </div>

        {/* Body */}
        {tab === 'send' ? (
          <div className="space-y-3">
            {sendError ? (
              <div className="p-4 rounded-2xl bg-papaya/15 text-ink text-body-sm flex items-start gap-2.5">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{sendError}</span>
              </div>
            ) : tooLargeForQR ? (
              <div className="p-5 rounded-2xl bg-marigold/40 text-ink text-body-sm text-center space-y-1.5">
                <p className="font-semibold">Too large for QR, use .cdsync instead.</p>
                <p className="text-caption text-graphite">
                  {formatByteSize(updateByteLength)}, {frames.length} frames (limit is{' '}
                  {MAX_QR_FRAMES} frames).
                </p>
              </div>
            ) : (
              <div className="flex flex-col items-center space-y-2.5">
                <div className="p-3 rounded-2xl bg-white ring-1 ring-ink/10 shadow-xs flex items-center justify-center">
                  <canvas
                    ref={qrCanvasRef}
                    width={240}
                    height={240}
                    className="w-[240px] h-[240px] block"
                  />
                </div>
                <div className="text-center space-y-0.5">
                  <p className="text-body-sm font-medium text-ink font-mono">
                    Frame {frames.length > 0 ? frameIndex + 1 : 0} / {frames.length}
                  </p>
                  <p className="text-caption text-graphite">
                    {formatByteSize(updateByteLength)}, {frames.length}{' '}
                    {frames.length === 1 ? 'frame' : 'frames'}
                    {stateHash ? ` · State ${stateHash}` : ''}
                  </p>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {mergedHash ? (
              <div className="p-6 rounded-2xl bg-mint/40 text-ink text-center space-y-2">
                <div className="w-10 h-10 rounded-full bg-mint text-ink mx-auto flex items-center justify-center">
                  <Check className="w-5 h-5" />
                </div>
                <p className="text-subheading font-serif">Merged ✓</p>
                <p className="text-caption text-graphite">
                  State hash: <code className="font-mono font-semibold text-ink">{mergedHash}</code>
                </p>
              </div>
            ) : cameraError ? (
              <div className="p-5 rounded-2xl bg-marigold/30 text-ink text-body-sm space-y-2">
                <div className="flex items-start gap-2.5">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{cameraError}</span>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="relative rounded-2xl overflow-hidden bg-ink aspect-square max-h-[240px] mx-auto ring-1 ring-ink/10">
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    className="w-full h-full object-cover"
                  />
                  <canvas ref={scanCanvasRef} className="hidden" />
                </div>

                {/* Progress Bar */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-caption text-graphite">
                    <span>
                      {totalCount > 0
                        ? `Scanning frames (${receivedCount} / ${totalCount})`
                        : 'Point camera at the sender’s QR code…'}
                    </span>
                    <span className="font-mono">{Math.round(progress * 100)}%</span>
                  </div>
                  <div className="h-2 w-full rounded-full bg-linen overflow-hidden">
                    <div
                      className="h-full bg-ink transition-all duration-150"
                      style={{ width: `${Math.round(progress * 100)}%` }}
                    />
                  </div>
                </div>

                {scanHint && (
                  <p className="text-caption text-papaya text-center" role="alert">
                    {scanHint}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Footer actions: Swap roles & Done */}
        <div className="flex items-center justify-between gap-2 pt-1">
          <button
            type="button"
            onClick={handleSwapRoles}
            className="btn btn-secondary h-10 px-4 gap-1.5 text-caption"
          >
            <ArrowLeftRight className="w-3.5 h-3.5" />
            <span>Swap roles</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            className="btn btn-primary h-10 px-5 text-caption"
          >
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

