import React, { useState, useRef, useEffect } from 'react';
import { SignatureBox, ProcessedDoc } from '../types';
import { buildConvergedPDF, downloadUint8ArrayAsFile, formatBytes } from '../utils/pdfProcessor';
import {
  FileText,
  Upload,
  ZoomIn,
  ZoomOut,
  Trash2,
  Download,
  PenTool,
  Type,
  Eraser,
  Check,
} from 'lucide-react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import { useCRDTSync } from '../hooks/useCRDTSync';
import { attributionTitle } from '../lib/presence';
import { SyncWaitingCard } from './SyncWaitingCard';

interface SignToolProps {
  onDocumentProcessed: (doc: ProcessedDoc) => void;
  rawPdfBytes: Uint8Array | null;
  documentId: string | null;
  fileName: string;
  crdt: ReturnType<typeof useCRDTSync>;
  onUploadFile?: (file: File) => void;
}

export const SignTool: React.FC<SignToolProps> = ({
  onDocumentProcessed,
  rawPdfBytes,
  documentId,
  fileName,
  crdt,
  onUploadFile,
}) => {
  const [activeTab, setActiveTab] = useState<'draw' | 'type' | 'upload'>('draw');
  const [zoomLevel, setZoomLevel] = useState<number>(100);
  const [numPages, setNumPages] = useState<number>(1);
  const [typedName, setTypedName] = useState('John Doe');

  const [activeSignatureDataUrl, setActiveSignatureDataUrl] = useState<string | null>(null);
  const [draggingSigId, setDraggingSigId] = useState<string | null>(null);
  const [startX, setStartX] = useState(0);
  const [startY, setStartY] = useState(0);
  const [processing, setProcessing] = useState(false);

  const sigCanvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawingSig, setIsDrawingSig] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);

  const pdfBlobUrl = React.useMemo(() => {
    if (!rawPdfBytes) return null;
    return URL.createObjectURL(new Blob([rawPdfBytes as any], { type: 'application/pdf' }));
  }, [rawPdfBytes]);

  useEffect(() => {
    return () => {
      if (pdfBlobUrl) URL.revokeObjectURL(pdfBlobUrl);
    };
  }, [pdfBlobUrl]);

  // Initialize drawing canvas
  useEffect(() => {
    if (activeTab === 'draw' && sigCanvasRef.current) {
      const ctx = sigCanvasRef.current.getContext('2d');
      if (ctx) {
        ctx.strokeStyle = '#1a1c1c';
        ctx.lineWidth = 2.5;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
      }
    }
  }, [activeTab]);

  const clearSigCanvas = () => {
    if (sigCanvasRef.current) {
      const ctx = sigCanvasRef.current.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, sigCanvasRef.current.width, sigCanvasRef.current.height);
      }
      setActiveSignatureDataUrl(null);
    }
  };

  const startDrawSig = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = sigCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    ctx.beginPath();
    ctx.moveTo(e.clientX - rect.left, e.clientY - rect.top);
    setIsDrawingSig(true);
  };

  const drawSig = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawingSig || !sigCanvasRef.current) return;
    const ctx = sigCanvasRef.current.getContext('2d');
    if (!ctx) return;

    const rect = sigCanvasRef.current.getBoundingClientRect();
    ctx.lineTo(e.clientX - rect.left, e.clientY - rect.top);
    ctx.stroke();
  };

  const finishDrawSig = () => {
    if (!isDrawingSig || !sigCanvasRef.current) return;
    setIsDrawingSig(false);
    setActiveSignatureDataUrl(sigCanvasRef.current.toDataURL('image/png'));
  };

  const handleGenerateTypedSig = (name: string = typedName) => {
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 150;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.font = 'italic 42px "Brush Script MT", "Caveat", "Segoe Script", cursive';
      ctx.fillStyle = '#002060';
      ctx.fillText(name, 30, 90);
      setActiveSignatureDataUrl(canvas.toDataURL('image/png'));
    }
  };

  const handleUploadSig = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        setActiveSignatureDataUrl(event.target?.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const getCoordinates = (e: React.MouseEvent, canvasEl: HTMLDivElement) => {
    const rect = canvasEl.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    return { x, y };
  };

  const handlePageClick = (pageIndex: number, e: React.MouseEvent, canvasEl: HTMLDivElement) => {
    const target = e.target as HTMLElement;
    if (target.closest('.sig-node') || target.closest('.delete-btn')) return;

    if (activeSignatureDataUrl) {
      const { x, y } = getCoordinates(e, canvasEl);
      crdt.addSignature({
        pageIndex,
        x: Math.max(0, x - 10),
        y: Math.max(0, y - 5),
        width: 20,
        height: 10,
        dataUrl: activeSignatureDataUrl,
      });
    }
  };

  const handlePointerDownSig = (e: React.MouseEvent, id: string, canvasEl: HTMLDivElement) => {
    e.stopPropagation();
    setDraggingSigId(id);
    const { x, y } = getCoordinates(e, canvasEl);
    setStartX(x);
    setStartY(y);
  };

  const handlePointerMove = (e: React.MouseEvent, canvasEl: HTMLDivElement) => {
    if (!draggingSigId) return;
    const { x, y } = getCoordinates(e, canvasEl);
    const dx = x - startX;
    const dy = y - startY;

    const current = crdt.signatures.find((s) => s.id === draggingSigId);
    if (current) {
      crdt.updateSignature(draggingSigId, { x: current.x + dx, y: current.y + dy });
    }
    setStartX(x);
    setStartY(y);
  };

  const handleExportSigned = async () => {
    if (!rawPdfBytes) return;
    try {
      setProcessing(true);
      const signedBytes = await buildConvergedPDF(rawPdfBytes, crdt.snapshot);
      const outputName = fileName.replace(/\.pdf$/i, '') + '-signed.pdf';
      downloadUint8ArrayAsFile(signedBytes, outputName);

      onDocumentProcessed({
        id: crypto.randomUUID(),
        name: outputName,
        action: 'Signed',
        size: formatBytes(signedBytes.byteLength),
        timestamp: Date.now(),
        timeAgo: 'Just now',
        blob: new Blob([signedBytes as any], { type: 'application/pdf' }),
        documentId: documentId || undefined,
      });
    } catch (err) {
      alert('Error signing PDF: ' + err);
    } finally {
      setProcessing(false);
    }
  };

  if (!rawPdfBytes) {
    if (documentId) {
      return (
        <SyncWaitingCard
          documentId={documentId}
          peerCount={crdt.peerCount}
          pdfProgress={crdt.pdfProgress}
          syncStatus={crdt.syncStatus}
          transferLog={crdt.transferLog}
          onRequestPdf={crdt.requestPdfFromPeers}
          onUploadFile={onUploadFile}
        />
      );
    }

    return (
      <div className="max-w-[1000px] mx-auto px-4 py-16 text-center">
        <div className="bg-white/60 rounded-4xl border-2 border-dashed border-ink/15 p-12 space-y-4">
          <div className="w-14 h-14 rounded-2xl bg-sky text-ink flex items-center justify-center mx-auto">
            <PenTool className="w-6 h-6" />
          </div>
          <h2 className="font-serif text-subheading text-ink">No PDF Active</h2>
          <p className="text-body-sm text-graphite max-w-sm mx-auto">
            Upload a PDF or return to the Dashboard to load the demo confidential agreement.
          </p>
          <label className="btn btn-primary cursor-pointer">
            <Upload className="w-4 h-4" />
            <span>Select PDF</span>
            <input type="file" accept="application/pdf" onChange={(e) => {
              const file = e.target.files?.[0];
              if (file && onUploadFile) onUploadFile(file);
            }} className="hidden" />
          </label>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-var(--header-h))]">
      {/* Top Toolbar */}
      <div className="mx-4 md:mx-6 mt-1 bg-white rounded-3xl shadow-subtle px-2 py-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 z-30">
        <div className="flex flex-wrap items-center gap-2">
          <div className="segmented">
            <button
              onClick={() => setActiveTab('draw')}
              aria-pressed={activeTab === 'draw'}
              className="segment"
            >
              <PenTool className="w-3.5 h-3.5" />
              <span>Draw</span>
            </button>
            <button
              onClick={() => {
                setActiveTab('type');
                handleGenerateTypedSig(typedName);
              }}
              aria-pressed={activeTab === 'type'}
              className="segment"
            >
              <Type className="w-3.5 h-3.5" />
              <span>Type</span>
            </button>
            <button
              onClick={() => setActiveTab('upload')}
              aria-pressed={activeTab === 'upload'}
              className="segment"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>Upload</span>
            </button>
          </div>

          {activeTab === 'draw' && (
            <div className="flex items-center gap-1.5 border-l border-ash pl-3">
              <canvas
                ref={sigCanvasRef}
                width={180}
                height={40}
                onMouseDown={startDrawSig}
                onMouseMove={drawSig}
                onMouseUp={finishDrawSig}
                onMouseLeave={finishDrawSig}
                className="bg-white ring-1 ring-ash rounded-xl cursor-crosshair"
              />
              <button
                onClick={clearSigCanvas}
                className="btn btn-ghost h-8 w-8 px-0"
                title="Clear Signature"
                aria-label="Clear Signature"
              >
                <Eraser className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {activeTab === 'type' && (
            <div className="flex items-center gap-2 border-l border-ash pl-3">
              <input
                type="text"
                value={typedName}
                onChange={(e) => {
                  setTypedName(e.target.value);
                  handleGenerateTypedSig(e.target.value);
                }}
                aria-label="Name to sign"
                className="field h-[34px] w-40 rounded-full bg-cloud border-transparent text-caption px-3.5"
              />
            </div>
          )}

          {activeTab === 'upload' && (
            <div className="flex items-center gap-2 border-l border-ash pl-3">
              <label className="btn btn-soft h-[34px] px-3.5 text-caption cursor-pointer">
                Choose PNG
                <input type="file" accept="image/png,image/jpeg" onChange={handleUploadSig} className="hidden" />
              </label>
            </div>
          )}

          {activeSignatureDataUrl ? (
            <span className="chip bg-mint">
              Click anywhere on PDF to stamp
            </span>
          ) : (
            <span className="text-caption text-graphite">
              Create signature to stamp on document
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center bg-cloud rounded-full p-0.5 text-caption">
            <button onClick={() => setZoomLevel((z) => Math.max(50, z - 10))} aria-label="Zoom out" className="w-[26px] h-[26px] rounded-full flex items-center justify-center text-graphite hover:text-ink hover:bg-white">
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <span className="tabular-nums font-medium w-11 text-center">{zoomLevel}%</span>
            <button onClick={() => setZoomLevel((z) => Math.min(200, z + 10))} aria-label="Zoom in" className="w-[26px] h-[26px] rounded-full flex items-center justify-center text-graphite hover:text-ink hover:bg-white">
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
          </div>

          <button
            onClick={handleExportSigned}
            disabled={processing}
            className="btn btn-primary h-[34px] px-4 text-caption"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{processing ? 'Signing...' : 'Save & Download'}</span>
          </button>
        </div>
      </div>

      {/* Viewport */}
      <div
        ref={containerRef}
        onMouseUp={() => setDraggingSigId(null)}
        className="flex-1 overflow-auto p-8 flex justify-center items-start"
      >
        <Document
          file={pdfBlobUrl}
          onLoadSuccess={({ numPages: count }) => setNumPages(count)}
          className="flex flex-col items-center space-y-8"
        >
          {Array.from({ length: numPages }, (_, pageIdx) => {
            const pageSigs = crdt.signatures.filter((s) => s.pageIndex === pageIdx);

            return (
              <div
                key={pageIdx}
                ref={(el) => {
                  pageRefs.current[pageIdx] = el;
                }}
                onClick={(e) => {
                  const targetCanvas = pageRefs.current[pageIdx];
                  if (targetCanvas) handlePageClick(pageIdx, e, targetCanvas);
                }}
                onMouseMove={(e) => {
                  const targetCanvas = pageRefs.current[pageIdx];
                  if (targetCanvas) handlePointerMove(e, targetCanvas);
                }}
                className={`relative bg-white shadow-xl rounded-lg select-none overflow-hidden ${
                  activeSignatureDataUrl ? 'cursor-copy' : 'cursor-default'
                }`}
                style={{
                  transform: `scale(${zoomLevel / 100})`,
                  transformOrigin: 'top center',
                  marginBottom: `${(zoomLevel / 100 - 1) * 300}px`,
                }}
              >
                <Page
                  pageNumber={pageIdx + 1}
                  renderTextLayer={false}
                  renderAnnotationLayer={false}
                  className="pointer-events-none"
                />

                {/* Stamped signatures layer */}
                {pageSigs.map((s) => (
                  <div
                    key={s.id}
                    title={attributionTitle(s)}
                    className="sig-node absolute cursor-move border border-dashed border-azure/60 hover:border-azure group p-1 bg-white/40"
                    style={{
                      left: `${s.x}%`,
                      top: `${s.y}%`,
                      width: `${s.width}%`,
                      height: `${s.height}%`,
                    }}
                    onMouseDown={(e) => {
                      const targetCanvas = pageRefs.current[pageIdx];
                      if (targetCanvas) handlePointerDownSig(e, s.id, targetCanvas);
                    }}
                  >
                    <img src={s.dataUrl} alt="Signature" className="w-full h-full object-contain pointer-events-none" />
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        crdt.removeSignature(s.id);
                      }}
                      className="delete-btn opacity-0 group-hover:opacity-100 absolute -top-3 -right-3 w-5 h-5 bg-papaya text-white rounded-full flex items-center justify-center shadow-md-3 transition-opacity"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            );
          })}
        </Document>
      </div>
    </div>
  );
};
