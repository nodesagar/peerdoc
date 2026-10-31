import React, { useState, useRef, useEffect } from 'react';
import { ProcessedDoc, WhiteoutBox, TextOverlay } from '../types';
import { buildConvergedPDF, downloadUint8ArrayAsFile, formatBytes } from '../utils/pdfProcessor';
import {
  FileText,
  Upload,
  Check,
  Eraser,
  Type,
  RotateCcw,
  Trash2,
  ZoomIn,
  ZoomOut,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Download,
  Share2,
} from 'lucide-react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import { useCRDTSync } from '../hooks/useCRDTSync';
import { SyncWaitingCard } from './SyncWaitingCard';

const FontSelect = ({ value, onChange }: { value: string; onChange: (val: string) => void }) => {
  const [isOpen, setIsOpen] = useState(false);
  const fonts = ['Helvetica', 'Arial', 'Verdana', 'Times New Roman', 'Georgia', 'Courier New'];
  const displayValue = value === 'TimesRoman' ? 'Times New Roman' : value === 'Courier' ? 'Courier New' : value;

  return (
    <div className="relative">
      <div
        className="w-full bg-[#f4f3f2] border border-black/10 rounded-lg text-xs px-2.5 py-1.5 text-[#1a1c1c] cursor-pointer flex justify-between items-center outline-none hover:border-[#10b981] transition-colors"
        onClick={() => setIsOpen(!isOpen)}
      >
        <span>{displayValue}</span>
        <ChevronDown className="w-3.5 h-3.5 text-black/50" />
      </div>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div className="absolute z-50 w-full mt-1.5 bg-[#1a1c23] rounded-xl border border-white/10 shadow-lg py-1">
            {fonts.map((f) => (
              <div
                key={f}
                className={`px-3 py-1.5 text-xs cursor-pointer flex justify-between items-center transition-colors ${
                  displayValue === f
                    ? 'bg-[#3b82f6]/20 text-[#3b82f6] border-l-2 border-[#3b82f6]'
                    : 'text-white hover:bg-white/5 border-l-2 border-transparent'
                }`}
                onClick={() => {
                  onChange(f);
                  setIsOpen(false);
                }}
              >
                <span>{f}</span>
                {displayValue === f && <Check className="w-3 h-3" />}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

interface EditToolProps {
  onDocumentProcessed: (doc: ProcessedDoc) => void;
  rawPdfBytes: Uint8Array | null;
  documentId: string | null;
  fileName: string;
  crdt: ReturnType<typeof useCRDTSync>;
  onUploadFile?: (file: File) => void;
}

export const EditTool: React.FC<EditToolProps> = ({
  onDocumentProcessed,
  rawPdfBytes,
  documentId,
  fileName,
  crdt,
  onUploadFile,
}) => {
  const [activeTool, setActiveTool] = useState<'text' | 'eraser'>('text');
  const [zoomLevel, setZoomLevel] = useState<number>(100);
  const [scrollMode, setScrollMode] = useState<'normal' | 'page'>('normal');

  const [numPages, setNumPages] = useState<number>(1);
  const [currentPage, setCurrentPage] = useState<number>(1);

  // Transient interaction state (local during drag, committed to CRDT on release)
  const [isDrawing, setIsDrawing] = useState(false);
  const [startX, setStartX] = useState(0);
  const [startY, setStartY] = useState(0);
  const [currentBox, setCurrentBox] = useState<{ x: number; y: number; w: number; h: number; pageIndex: number } | null>(null);

  const [activeTextId, setActiveTextId] = useState<string | null>(null);
  const [draggingEraserId, setDraggingEraserId] = useState<string | null>(null);
  const [draggingTextId, setDraggingTextId] = useState<string | null>(null);

  const [processing, setProcessing] = useState(false);

  // Formatting state
  const [textStyle, setTextStyle] = useState({
    fontFamily: 'Helvetica',
    fontSize: 14,
    isBold: false,
    isItalic: false,
    color: '#1a1c1c',
  });
  const [eraserColor, setEraserColor] = useState('#ffffff');

  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);

  const colors = ['#ffffff', '#808080', '#f64932', '#3b82f6', '#10b981', '#a855f7', '#f97316', '#06b6d4', '#1a1c1c'];

  // Convert rawPdfBytes to Blob URL to prevent PDF.js Web Worker ArrayBuffer transfer detachment
  const pdfBlobUrl = React.useMemo(() => {
    if (!rawPdfBytes) return null;
    return URL.createObjectURL(new Blob([rawPdfBytes as any], { type: 'application/pdf' }));
  }, [rawPdfBytes]);

  useEffect(() => {
    return () => {
      if (pdfBlobUrl) URL.revokeObjectURL(pdfBlobUrl);
    };
  }, [pdfBlobUrl]);

  // Keep textStyle updated when selecting text overlay
  useEffect(() => {
    if (activeTextId) {
      const overlay = crdt.textOverlays.find((t) => t.id === activeTextId);
      if (overlay) {
        setTextStyle({
          fontFamily: overlay.fontFamily || 'Helvetica',
          fontSize: overlay.fontSize,
          isBold: overlay.isBold || false,
          isItalic: overlay.isItalic || false,
          color: overlay.color || '#1a1c1c',
        });
      }
    }
  }, [activeTextId, crdt.textOverlays]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && onUploadFile) {
      onUploadFile(file);
    }
  };

  const getCoordinates = (e: React.MouseEvent | React.TouchEvent, canvasEl: HTMLDivElement) => {
    const rect = canvasEl.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : (e as React.MouseEvent).clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : (e as React.MouseEvent).clientY;

    const x = ((clientX - rect.left) / rect.width) * 100;
    const y = ((clientY - rect.top) / rect.height) * 100;
    return { x, y };
  };

  const handlePointerDown = (
    e: React.MouseEvent | React.TouchEvent,
    pageIndex: number,
    canvasEl: HTMLDivElement
  ) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.closest('.delete-btn')) {
      return;
    }

    const eraserEl = target.closest('.eraser-node');
    if (eraserEl) {
      const id = eraserEl.getAttribute('data-id');
      if (id) {
        setDraggingEraserId(id);
        const { x, y } = getCoordinates(e, canvasEl);
        setStartX(x);
        setStartY(y);
        setActiveTool('eraser');
        setActiveTextId(null);
        return;
      }
    }

    const textNode = target.closest('.text-overlay-node');
    if (textNode) {
      const id = textNode.getAttribute('data-id');
      if (id) {
        setDraggingTextId(id);
        setActiveTextId(id);
        setActiveTool('text');
        const { x, y } = getCoordinates(e, canvasEl);
        setStartX(x);
        setStartY(y);
        return;
      }
    }

    // Canvas click
    if (activeTool === 'eraser') {
      setIsDrawing(true);
      const { x, y } = getCoordinates(e, canvasEl);
      setStartX(x);
      setStartY(y);
      setCurrentBox({ x, y, w: 0, h: 0, pageIndex });
    } else if (activeTool === 'text') {
      const { x, y } = getCoordinates(e, canvasEl);
      const newId = crdt.addTextOverlay({
        pageIndex,
        x,
        y,
        text: 'New Text',
        ...textStyle,
      } as any);
      setActiveTextId(newId);
    }
  };

  const handlePointerMove = (
    e: React.MouseEvent | React.TouchEvent,
    canvasEl: HTMLDivElement
  ) => {
    const { x, y } = getCoordinates(e, canvasEl);

    if (draggingTextId) {
      const dx = x - startX;
      const dy = y - startY;
      const current = crdt.textOverlays.find((t) => t.id === draggingTextId);
      if (current) {
        crdt.updateTextOverlay(draggingTextId, { x: current.x + dx, y: current.y + dy });
      }
      setStartX(x);
      setStartY(y);
      return;
    }

    if (draggingEraserId) {
      const dx = x - startX;
      const dy = y - startY;
      const current = crdt.whiteouts.find((w) => w.id === draggingEraserId);
      if (current) {
        crdt.updateWhiteout(draggingEraserId, { x: current.x + dx, y: current.y + dy });
      }
      setStartX(x);
      setStartY(y);
      return;
    }

    if (isDrawing && activeTool === 'eraser' && currentBox) {
      setCurrentBox({
        ...currentBox,
        x: Math.min(startX, x),
        y: Math.min(startY, y),
        w: Math.abs(x - startX),
        h: Math.abs(y - startY),
      });
    }
  };

  const handlePointerUp = () => {
    if (draggingTextId) {
      setDraggingTextId(null);
    } else if (draggingEraserId) {
      setDraggingEraserId(null);
    } else if (isDrawing && activeTool === 'eraser' && currentBox && currentBox.w > 1 && currentBox.h > 1) {
      crdt.addWhiteout({
        pageIndex: currentBox.pageIndex,
        x: currentBox.x,
        y: currentBox.y,
        width: currentBox.w,
        height: currentBox.h,
        color: eraserColor,
      });
    }
    setIsDrawing(false);
    setCurrentBox(null);
  };

  const applyTextUpdate = (updates: Partial<TextOverlay>) => {
    setTextStyle((prev) => ({ ...prev, ...updates }));
    if (activeTextId) {
      crdt.updateTextOverlay(activeTextId, updates);
    }
  };

  const handleExportPDF = async () => {
    if (!rawPdfBytes) return;
    try {
      setProcessing(true);
      const convergedBytes = await buildConvergedPDF(rawPdfBytes, crdt.snapshot);
      const outputName = fileName.replace(/\.pdf$/i, '') + '-edited.pdf';
      downloadUint8ArrayAsFile(convergedBytes, outputName);

      onDocumentProcessed({
        id: crypto.randomUUID(),
        name: outputName,
        action: 'Edited',
        size: formatBytes(convergedBytes.byteLength),
        timestamp: Date.now(),
        timeAgo: 'Just now',
        blob: new Blob([convergedBytes as any], { type: 'application/pdf' }),
        documentId: documentId || undefined,
      });
    } catch (err) {
      console.error('Failed to export edited PDF:', err);
      alert('Error building final PDF from CRDT state: ' + err);
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
          onImportSync={crdt.importSync}
        />
      );
    }

    return (
      <div className="max-w-[1000px] mx-auto px-4 py-16 text-center">
        <div className="bg-white rounded-2xl border-2 border-dashed border-black/15 p-12 space-y-4">
          <div className="w-12 h-12 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center mx-auto">
            <Upload className="w-6 h-6" />
          </div>
          <h2 className="text-xl font-bold">No PDF Active</h2>
          <p className="text-xs text-[#5f6368] max-w-sm mx-auto">
            Upload a PDF or return to the Dashboard to load the demo confidential agreement.
          </p>
          <label className="inline-flex items-center space-x-2 bg-[#005db2] text-white px-5 py-2.5 rounded-xl cursor-pointer hover:bg-[#004a8f] transition-colors text-sm font-medium">
            <Upload className="w-4 h-4" />
            <span>Select PDF</span>
            <input type="file" accept="application/pdf" onChange={handleFileUpload} className="hidden" />
          </label>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-65px)] bg-[#f4f3f2]">
      {/* Top Controls Toolbar */}
      <div className="bg-white border-b border-black/10 px-4 py-2 flex flex-wrap items-center justify-between gap-3 shadow-2xs z-30">
        <div className="flex items-center space-x-2">
          {/* Tool switch */}
          <div className="flex bg-[#f4f3f2] p-1 rounded-xl border border-black/5">
            <button
              onClick={() => setActiveTool('text')}
              className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                activeTool === 'text'
                  ? 'bg-white text-[#1a1c1c] shadow-2xs'
                  : 'text-[#5f6368] hover:text-[#1a1c1c]'
              }`}
            >
              <Type className="w-3.5 h-3.5" />
              <span>Text</span>
            </button>
            <button
              onClick={() => setActiveTool('eraser')}
              className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                activeTool === 'eraser'
                  ? 'bg-white text-[#1a1c1c] shadow-2xs'
                  : 'text-[#5f6368] hover:text-[#1a1c1c]'
              }`}
            >
              <Eraser className="w-3.5 h-3.5" />
              <span>Eraser</span>
            </button>
          </div>

          {/* Text options if active */}
          {activeTool === 'text' && (
            <div className="flex items-center space-x-2 pl-2 border-l border-black/10">
              <div className="w-36">
                <FontSelect
                  value={textStyle.fontFamily}
                  onChange={(f) => applyTextUpdate({ fontFamily: f as any })}
                />
              </div>

              <div className="flex items-center space-x-1 bg-[#f4f3f2] rounded-lg px-2 py-1 text-xs">
                <button
                  onClick={() => applyTextUpdate({ fontSize: Math.max(8, textStyle.fontSize - 2) })}
                  className="px-1 font-bold text-black/60 hover:text-black"
                >
                  -
                </button>
                <span className="font-mono w-5 text-center">{textStyle.fontSize}</span>
                <button
                  onClick={() => applyTextUpdate({ fontSize: Math.min(72, textStyle.fontSize + 2) })}
                  className="px-1 font-bold text-black/60 hover:text-black"
                >
                  +
                </button>
              </div>

              <button
                onClick={() => applyTextUpdate({ isBold: !textStyle.isBold })}
                className={`px-2.5 py-1 text-xs font-bold rounded-lg border transition-colors ${
                  textStyle.isBold ? 'bg-[#005db2] text-white border-transparent' : 'bg-[#f4f3f2] text-black/70 border-black/5'
                }`}
              >
                B
              </button>

              <button
                onClick={() => applyTextUpdate({ isItalic: !textStyle.isItalic })}
                className={`px-2.5 py-1 text-xs italic font-serif rounded-lg border transition-colors ${
                  textStyle.isItalic ? 'bg-[#005db2] text-white border-transparent' : 'bg-[#f4f3f2] text-black/70 border-black/5'
                }`}
              >
                I
              </button>

              <div className="flex items-center space-x-1 pl-1">
                {colors.slice(0, 6).map((c) => (
                  <button
                    key={c}
                    onClick={() => applyTextUpdate({ color: c })}
                    className={`w-5 h-5 rounded-full border ${textStyle.color === c ? 'ring-2 ring-[#005db2]' : 'border-black/20'}`}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Eraser options */}
          {activeTool === 'eraser' && (
            <div className="flex items-center space-x-2 pl-2 border-l border-black/10">
              <span className="text-xs text-black/60">Color:</span>
              <div className="flex items-center space-x-1">
                {['#ffffff', '#faf9f8', '#f4f3f2', '#1a1c1c'].map((c) => (
                  <button
                    key={c}
                    onClick={() => setEraserColor(c)}
                    className={`w-5 h-5 rounded-full border ${eraserColor === c ? 'ring-2 ring-emerald-500' : 'border-black/20'}`}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right tools: Zoom, Pagination, Save */}
        <div className="flex items-center space-x-3">
          <div className="flex items-center space-x-1 text-xs bg-[#f4f3f2] rounded-lg px-2 py-1">
            <button
              onClick={() => setZoomLevel((z) => Math.max(50, z - 10))}
              className="p-1 hover:text-[#005db2]"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <span className="font-mono text-[11px] w-9 text-center">{zoomLevel}%</span>
            <button
              onClick={() => setZoomLevel((z) => Math.min(200, z + 10))}
              className="p-1 hover:text-[#005db2]"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
          </div>

          <button
            onClick={handleExportPDF}
            disabled={processing}
            className="flex items-center space-x-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold px-4 py-2 rounded-xl shadow-2xs transition-colors cursor-pointer disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{processing ? 'Rendering...' : 'Save & Download'}</span>
          </button>
        </div>
      </div>

      {/* Canvas Viewport */}
      <div
        ref={containerRef}
        onPointerUp={handlePointerUp}
        className="flex-1 overflow-auto p-8 flex justify-center items-start"
      >
        <Document
          file={pdfBlobUrl}
          onLoadSuccess={({ numPages: count }) => setNumPages(count)}
          className="flex flex-col items-center space-y-8"
        >
          {Array.from({ length: numPages }, (_, pageIdx) => {
            const pageWhiteouts = crdt.whiteouts.filter((w) => w.pageIndex === pageIdx);
            const pageTexts = crdt.textOverlays.filter((t) => t.pageIndex === pageIdx);

            return (
              <div
                key={pageIdx}
                ref={(el) => {
                  pageRefs.current[pageIdx] = el;
                }}
                className="relative bg-white shadow-xl rounded-md border border-black/10 select-none overflow-hidden"
                style={{
                  transform: `scale(${zoomLevel / 100})`,
                  transformOrigin: 'top center',
                  marginBottom: `${(zoomLevel / 100 - 1) * 300}px`,
                }}
                onPointerDown={(e) => {
                  const targetCanvas = pageRefs.current[pageIdx];
                  if (targetCanvas) handlePointerDown(e, pageIdx, targetCanvas);
                }}
                onPointerMove={(e) => {
                  const targetCanvas = pageRefs.current[pageIdx];
                  if (targetCanvas) handlePointerMove(e, targetCanvas);
                }}
              >
                <Page
                  pageNumber={pageIdx + 1}
                  renderTextLayer={false}
                  renderAnnotationLayer={false}
                  className="pointer-events-none"
                />

                {/* Whiteouts layer */}
                {pageWhiteouts.map((w) => (
                  <div
                    key={w.id}
                    data-id={w.id}
                    className="eraser-node absolute cursor-move border border-dashed border-black/20 hover:border-black/50 group"
                    style={{
                      left: `${w.x}%`,
                      top: `${w.y}%`,
                      width: `${w.width}%`,
                      height: `${w.height}%`,
                      backgroundColor: w.color || '#ffffff',
                    }}
                  >
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        crdt.removeWhiteout(w.id);
                      }}
                      className="delete-btn opacity-0 group-hover:opacity-100 absolute -top-3 -right-3 w-5 h-5 bg-red-600 text-white rounded-full flex items-center justify-center shadow-md transition-opacity"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}

                {/* In-progress drawing whiteout box */}
                {isDrawing && currentBox && currentBox.pageIndex === pageIdx && (
                  <div
                    className="absolute pointer-events-none border border-emerald-500"
                    style={{
                      left: `${currentBox.x}%`,
                      top: `${currentBox.y}%`,
                      width: `${currentBox.w}%`,
                      height: `${currentBox.h}%`,
                      backgroundColor: eraserColor,
                      opacity: 0.8,
                    }}
                  />
                )}

                {/* Text overlays layer */}
                {pageTexts.map((t) => (
                  <div
                    key={t.id}
                    data-id={t.id}
                    className={`text-overlay-node absolute cursor-move group px-1 py-0.5 rounded border transition-colors ${
                      activeTextId === t.id ? 'border-[#005db2] bg-blue-50/20' : 'border-transparent hover:border-black/20'
                    }`}
                    style={{
                      left: `${t.x}%`,
                      top: `${t.y}%`,
                      fontFamily: t.fontFamily || 'Helvetica',
                      fontSize: `${t.fontSize}px`,
                      fontWeight: t.isBold ? 'bold' : 'normal',
                      fontStyle: t.isItalic ? 'italic' : 'normal',
                      color: t.color || '#1a1c1c',
                    }}
                  >
                    <input
                      type="text"
                      value={t.text}
                      onChange={(e) => crdt.updateTextOverlay(t.id, { text: e.target.value })}
                      onFocus={() => setActiveTextId(t.id)}
                      className="bg-transparent outline-none border-b border-transparent focus:border-[#005db2] min-w-[60px]"
                      style={{ fontSize: 'inherit', color: 'inherit', fontFamily: 'inherit' }}
                    />
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        crdt.removeTextOverlay(t.id);
                      }}
                      className="delete-btn opacity-0 group-hover:opacity-100 absolute -top-3 -right-3 w-5 h-5 bg-red-600 text-white rounded-full flex items-center justify-center shadow-md transition-opacity"
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
