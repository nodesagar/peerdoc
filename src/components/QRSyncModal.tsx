import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import * as Y from 'yjs';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import {
  QrCode,
  Camera,
  ArrowLeftRight,
  Check,
  AlertCircle,
  X,
  Pause,
  Play,
} from 'lucide-react';
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

interface NativeBarcodeDetector {
  detect(source: ImageBitmapSource): Promise<Array<{ rawValue?: string }>>;
}

declare global {
  interface Window {
    BarcodeDetector?: {
      new (options?: { formats?: string[] }): NativeBarcodeDetector;
    };
  }
}

const SEND_FRAME_INTERVAL_MS = 350;
const SCAN_TICK_MS = 80;
const MAX_SCAN_DIM = 600;

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
  const [isPaused, setIsPaused] = useState(false);
  const [updateByteLength, setUpdateByteLength] = useState(0);
  const [sendError, setSendError] = useState<string | null>(null);
  const [stateHash, setStateHash] = useState<string>('');
  const qrCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Receive state
  const [receivedCount, setReceivedCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [receivedIndices, setReceivedIndices] = useState<number[]>([]);
  const [lastScannedIndex, setLastScannedIndex] = useState<number | null>(null);
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
      setIsPaused(false);
      setReceivedCount(0);
      setTotalCount(0);
      setReceivedIndices([]);
      setLastScannedIndex(null);
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
        setIsPaused(false);
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

  // Cycle frames on the Send tab unless paused
  useEffect(() => {
    if (
      !isOpen ||
      tab !== 'send' ||
      isPaused ||
      frames.length <= 1 ||
      frames.length > MAX_QR_FRAMES
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      setFrameIndex((prev) => (prev + 1) % frames.length);
    }, SEND_FRAME_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [isOpen, tab, isPaused, frames]);

  // Render current QR frame onto canvas (errorCorrectionLevel: 'L', large size & margin)
  useEffect(() => {
    if (!isOpen || tab !== 'send' || frames.length === 0 || frames.length > MAX_QR_FRAMES) {
      return;
    }
    const canvas = qrCanvasRef.current;
    const frame = frames[frameIndex] ?? frames[0];
    if (!canvas || !frame) return;

    QRCode.toCanvas(canvas, frame, {
      errorCorrectionLevel: 'L',
      width: 280,
      margin: 3,
      color: {
        dark: '#000000',
        light: '#FFFFFF',
      },
    }).catch((err) => {
      console.error('QR render error:', err);
    });
  }, [isOpen, tab, frames, frameIndex]);

  // Manage camera & non-overlapping scan loop on the Receive tab
  useEffect(() => {
    if (!isOpen || tab !== 'receive' || !doc || !documentId) {
      stopCamera();
      return;
    }

    let cancelled = false;
    let scanTimer: number | null = null;
    let tickCount = 0;

    finishingRef.current = false;
    collectorRef.current = new FrameCollector(documentId);
    setReceivedCount(0);
    setTotalCount(0);
    setReceivedIndices([]);
    setLastScannedIndex(null);
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

    let nativeDetector: NativeBarcodeDetector | null = null;
    if (typeof window !== 'undefined' && window.BarcodeDetector) {
      try {
        nativeDetector = new window.BarcodeDetector({ formats: ['qr_code'] });
      } catch {
        nativeDetector = null;
      }
    }

    const scheduleNextTick = (fn: () => void) => {
      if (!cancelled && !finishingRef.current) {
        scanTimer = window.setTimeout(fn, SCAN_TICK_MS);
      }
    };

    const handleDecodedString = async (raw: string): Promise<boolean> => {
      const collector = collectorRef.current;
      if (!collector || finishingRef.current || cancelled) return false;

      const rawFrame = raw.trim();
      if (!rawFrame) return false;

      let res = collector.add(rawFrame);

      // If the sender started a new session, reset the collector and accept the new session
      if (res.error && res.error.startsWith('Different session ID')) {
        collector.reset();
        res = collector.add(rawFrame);
      }

      if (res.error) {
        setScanHint(res.error);
        return false;
      }

      const parts = rawFrame.split('|');
      const parsedIndex = parts.length === 6 ? Number(parts[3]) : NaN;
      if (Number.isInteger(parsedIndex)) {
        setLastScannedIndex(parsedIndex);
      }

      setScanHint(null);
      setReceivedCount(res.received);
      setTotalCount(res.total);
      setReceivedIndices(collector.receivedIndices);
      setProgress(res.progress);

      if (res.complete) {
        finishingRef.current = true;
        stopCamera();
        try {
          const updateBytes = await collector.finish();
          Y.applyUpdate(doc, updateBytes, 'qr');
          const hash = await computeDocStateHash(doc);
          if (!cancelled) {
            setMergedHash(hash);
            setStateHash(hash);
          }
          return true;
        } catch (err) {
          if (!cancelled) {
            setScanHint(
              err instanceof Error ? err.message : 'Failed to decode QR sync payload'
            );
            collector.reset();
            setReceivedCount(0);
            setReceivedIndices([]);
            setProgress(0);
            finishingRef.current = false;
          }
          return false;
        }
      }

      return false;
    };

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
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

        const scanTick = async () => {
          if (cancelled || finishingRef.current) return;
          const video = videoRef.current;
          const canvas = scanCanvasRef.current;

          if (
            !video ||
            !canvas ||
            video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
            video.videoWidth === 0 ||
            video.videoHeight === 0
          ) {
            scheduleNextTick(scanTick);
            return;
          }

          tickCount++;
          let foundAny = false;

          // 1. Hardware-accelerated native BarcodeDetector (Android Chrome / iOS 17+ / macOS)
          if (nativeDetector) {
            try {
              const barcodes = await nativeDetector.detect(video);
              for (const b of barcodes) {
                if (b.rawValue) {
                  foundAny = true;
                  const done = await handleDecodedString(b.rawValue);
                  if (done) return;
                }
              }
            } catch {
              // Fall through to jsQR
            }
          }

          // 2. Software jsQR fallback on scaled full frame + center square crop
          if (!foundAny && !finishingRef.current && !cancelled) {
            const vw = video.videoWidth;
            const vh = video.videoHeight;
            const scale = Math.min(1, MAX_SCAN_DIM / Math.max(vw, vh));
            const targetW = Math.max(1, Math.round(vw * scale));
            const targetH = Math.max(1, Math.round(vh * scale));

            if (canvas.width !== targetW || canvas.height !== targetH) {
              canvas.width = targetW;
              canvas.height = targetH;
            }
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (ctx) {
              ctx.drawImage(video, 0, 0, vw, vh, 0, 0, targetW, targetH);
              const imageData = ctx.getImageData(0, 0, targetW, targetH);
              let code = jsQR(imageData.data, targetW, targetH, {
                inversionAttempts: 'attemptBoth',
              });

              // On odd ticks, if full frame didn't match, try a center square crop (optical zoom)
              if ((!code || !code.data) && tickCount % 2 === 1) {
                const minDim = Math.min(vw, vh);
                const cropDim = Math.floor(minDim * 0.7);
                const sx = Math.floor((vw - cropDim) / 2);
                const sy = Math.floor((vh - cropDim) / 2);
                const cropCanvasSize = Math.min(480, cropDim);
                if (canvas.width !== cropCanvasSize || canvas.height !== cropCanvasSize) {
                  canvas.width = cropCanvasSize;
                  canvas.height = cropCanvasSize;
                }
                ctx.drawImage(
                  video,
                  sx,
                  sy,
                  cropDim,
                  cropDim,
                  0,
                  0,
                  cropCanvasSize,
                  cropCanvasSize
                );
                const cropData = ctx.getImageData(0, 0, cropCanvasSize, cropCanvasSize);
                code = jsQR(cropData.data, cropCanvasSize, cropCanvasSize, {
                  inversionAttempts: 'attemptBoth',
                });
              }

              if (code && code.data) {
                const done = await handleDecodedString(code.data);
                if (done) return;
              }
            }
          }

          scheduleNextTick(scanTick);
        };

        scheduleNextTick(scanTick);
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
        window.clearTimeout(scanTimer);
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
                    width={280}
                    height={280}
                    style={{ imageRendering: 'pixelated' }}
                    className="w-[260px] h-[260px] sm:w-[280px] sm:h-[280px] block"
                  />
                </div>
                <div className="text-center space-y-0.5">
                  <div className="flex items-center justify-center gap-2">
                    <p className="text-body-sm font-medium text-ink font-mono">
                      Frame {frames.length > 0 ? frameIndex + 1 : 0} / {frames.length}
                    </p>
                    {frames.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setIsPaused((p) => !p)}
                        className="btn btn-ghost h-6 px-2 text-[11px] gap-1"
                        title={isPaused ? 'Resume cycling frames' : 'Pause on current frame'}
                      >
                        {isPaused ? (
                          <>
                            <Play className="w-3 h-3" />
                            <span>Play</span>
                          </>
                        ) : (
                          <>
                            <Pause className="w-3 h-3" />
                            <span>Pause</span>
                          </>
                        )}
                      </button>
                    )}
                  </div>
                  <p className="text-caption text-graphite">
                    {formatByteSize(updateByteLength)}, {frames.length}{' '}
                    {frames.length === 1 ? 'frame' : 'frames'}
                    {stateHash ? ` · State ${stateHash}` : ''}
                  </p>
                </div>

                {/* Clickable frame selector pills so user can also jump to any missing frame */}
                {frames.length > 1 && (
                  <div className="flex flex-wrap items-center justify-center gap-1 pt-0.5">
                    {frames.map((_, idx) => (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => {
                          setFrameIndex(idx);
                          setIsPaused(true);
                        }}
                        className={`h-6 min-w-6 px-1.5 rounded-lg text-[11px] font-mono transition-colors ${
                          idx === frameIndex
                            ? 'bg-ink text-white font-semibold'
                            : 'bg-linen text-graphite hover:text-ink'
                        }`}
                        title={`Show Frame ${idx + 1} (pauses auto-cycle)`}
                      >
                        {idx + 1}
                      </button>
                    ))}
                  </div>
                )}
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
                        ? `Scanning frames (${receivedCount} / ${totalCount})${
                            lastScannedIndex !== null ? ` · read #${lastScannedIndex + 1}` : ''
                          }`
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

                {/* Visual checklist of which frames have been captured vs missing */}
                {totalCount > 1 && (
                  <div className="flex flex-wrap items-center justify-center gap-1">
                    {Array.from({ length: totalCount }, (_, idx) => {
                      const captured = receivedIndices.includes(idx);
                      return (
                        <span
                          key={idx}
                          className={`h-6 min-w-7 px-1.5 rounded-lg text-[11px] font-mono inline-flex items-center justify-center gap-0.5 ${
                            captured
                              ? 'bg-mint text-ink font-semibold'
                              : 'bg-linen text-graphite'
                          }`}
                        >
                          {captured ? `✓${idx + 1}` : idx + 1}
                        </span>
                      );
                    })}
                  </div>
                )}

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
