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
          onRequestPdf={crdt.requestPdfFromPeers}
          onUploadFile={onUploadFile}
        />
      );
    }

    return (
      <div className="max-w-[1000px] mx-auto px-4 py-16 text-center">
        <div className="bg-white rounded-2xl border-2 border-dashed border-black/15 p-12 space-y-4">
          <div className="w-12 h-12 rounded-xl bg-purple-50 text-purple-600 flex items-center justify-center mx-auto">
            <PenTool className="w-6 h-6" />
          </div>
          <h2 className="text-xl font-bold">No PDF Active</h2>
          <p className="text-xs text-[#5f6368] max-w-sm mx-auto">
            Upload a PDF or return to the Dashboard to load the demo confidential agreement.
          </p>
          <label className="inline-flex items-center space-x-2 bg-[#005db2] text-white px-5 py-2.5 rounded-xl cursor-pointer hover:bg-[#004a8f] transition-colors text-sm font-medium">
            <Upload className="w-4 h-4" />
            <span>Select PDF</span>
            <input
              type="file"
              accept="application/pdf"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file && onUploadFile) onUploadFile(file);
              }}
              className="hidden"
            />
          </label>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-65px)] bg-[#f4f3f2]">
      {/* Top Toolbar */}
      <div className="bg-white border-b border-black/10 px-4 py-2 flex flex-wrap items-center justify-between gap-3 shadow-2xs z-30">
        <div className="flex items-center space-x-3">
          <div className="flex bg-[#f4f3f2] p-1 rounded-xl border border-black/5">
            <button
              onClick={() => setActiveTab('draw')}
              className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                activeTab === 'draw' ? 'bg-white text-[#1a1c1c] shadow-2xs' : 'text-[#5f6368] hover:text-[#1a1c1c]'
              }`}
            >
              <PenTool className="w-3.5 h-3.5" />
              <span>Draw</span>
            </button>
            <button
              onClick={() => {
                setActiveTab('type');
                handleGenerateTypedSig(typedName);
              }}
              className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                activeTab === 'type' ? 'bg-white text-[#1a1c1c] shadow-2xs' : 'text-[#5f6368] hover:text-[#1a1c1c]'
              }`}
            >
              <Type className="w-3.5 h-3.5" />
              <span>Type</span>
            </button>
            <button
              onClick={() => setActiveTab('upload')}
              className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                activeTab === 'upload' ? 'bg-white text-[#1a1c1c] shadow-2xs' : 'text-[#5f6368] hover:text-[#1a1c1c]'
              }`}
            >
              <Upload className="w-3.5 h-3.5" />
              <span>Upload</span>
            </button>
          </div>

          {activeTab === 'draw' && (
            <div className="flex items-center space-x-2 border-l border-black/10 pl-2">
              <canvas
                ref={sigCanvasRef}
                width={180}
                height={40}
                onMouseDown={startDrawSig}
                onMouseMove={drawSig}
                onMouseUp={finishDrawSig}
                onMouseLeave={finishDrawSig}
                className="bg-white border border-black/15 rounded-lg cursor-crosshair shadow-inner"
              />
              <button
                onClick={clearSigCanvas}
                className="p-1.5 hover:bg-black/5 text-[#5f6368] rounded-lg"
                title="Clear Signature"
              >
                <Eraser className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {activeTab === 'type' && (
            <div className="flex items-center space-x-2 border-l border-black/10 pl-2">
              <input
                type="text"
                value={typedName}
                onChange={(e) => {
                  setTypedName(e.target.value);
                  handleGenerateTypedSig(e.target.value);
                }}
                className="bg-[#f4f3f2] text-xs px-2.5 py-1.5 rounded-lg border border-black/10 outline-none w-36"
              />
            </div>
          )}

          {activeTab === 'upload' && (
            <div className="flex items-center space-x-2 border-l border-black/10 pl-2">
              <label className="text-xs bg-[#f4f3f2] hover:bg-black/10 px-3 py-1.5 rounded-lg cursor-pointer border border-black/10 font-medium">
                Choose PNG
                <input type="file" accept="image/png,image/jpeg" onChange={handleUploadSig} className="hidden" />
              </label>
            </div>
          )}

          {activeSignatureDataUrl ? (
            <span className="text-[11px] text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
              Click anywhere on PDF to stamp
            </span>
          ) : (
            <span className="text-[11px] text-[#5f6368]">
              Create signature to stamp on document
            </span>
          )}
        </div>

        <div className="flex items-center space-x-3">
          <div className="flex items-center space-x-1 text-xs bg-[#f4f3f2] rounded-lg px-2 py-1">
            <button onClick={() => setZoomLevel((z) => Math.max(50, z - 10))} className="p-1 hover:text-[#005db2]">
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <span className="font-mono text-[11px] w-9 text-center">{zoomLevel}%</span>
            <button onClick={() => setZoomLevel((z) => Math.min(200, z + 10))} className="p-1 hover:text-[#005db2]">
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
          </div>

          <button
            onClick={handleExportSigned}
            disabled={processing}
            className="flex items-center space-x-1.5 bg-purple-600 hover:bg-purple-700 text-white text-xs font-semibold px-4 py-2 rounded-xl shadow-2xs transition-colors cursor-pointer disabled:opacity-50"
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
                className={`relative bg-white shadow-xl rounded-md border border-black/10 select-none overflow-hidden ${
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
                    className="sig-node absolute cursor-move border border-dashed border-purple-500 hover:border-purple-700 group p-1 bg-white/40"
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
                      className="delete-btn opacity-0 group-hover:opacity-100 absolute -top-3 -right-3 w-5 h-5 bg-red-600 text-white rounded-full flex items-center justify-center shadow-md transition-opacity cursor-pointer"
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
