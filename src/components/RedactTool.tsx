import React, { useState, useRef } from 'react';
import { RedactionBox, ProcessedDoc, PDFMetadataInfo } from '../types';
import { buildConvergedPDF, downloadUint8ArrayAsFile, extractPDFMetadata, formatBytes } from '../utils/pdfProcessor';
import {
  FileText,
  Upload,
  Search,
  ZoomIn,
  ZoomOut,
  ChevronLeft,
  ChevronRight,
  ShieldCheck,
  ShieldAlert,
  Trash2,
  Download,
  Square,
  FileCode,
  Lock,
} from 'lucide-react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import { useCRDTSync } from '../hooks/useCRDTSync';
import { usePageFit } from '../hooks/usePageFit';
import { attributionTitle } from '../lib/presence';
import { SyncWaitingCard } from './SyncWaitingCard';

interface RedactToolProps {
  onDocumentProcessed: (doc: ProcessedDoc) => void;
  rawPdfBytes: Uint8Array | null;
  documentId: string | null;
  fileName: string;
  crdt: ReturnType<typeof useCRDTSync>;
  onUploadFile?: (file: File) => void;
}

export const RedactTool: React.FC<RedactToolProps> = ({
  onDocumentProcessed,
  rawPdfBytes,
  documentId,
  fileName,
  crdt,
  onUploadFile,
}) => {
  const [activeTab, setActiveTab] = useState<'draw' | 'wipe' | 'metadata'>('draw');
  const [zoomLevel, setZoomLevel] = useState<number>(100);
  const [numPages, setNumPages] = useState<number>(1);
  const [currentPage, setCurrentPage] = useState<number>(1);

  // Search Wipe
  const [searchText, setSearchText] = useState<string>('Confidential');
  const [isSearching, setIsSearching] = useState<boolean>(false);

  // Metadata tab
  const [metadata, setMetadata] = useState<PDFMetadataInfo | null>(null);

  // Drawing state
  const [isDrawing, setIsDrawing] = useState(false);
  const [startX, setStartX] = useState(0);
  const [startY, setStartY] = useState(0);
  const [currentBox, setCurrentBox] = useState<{ x: number; y: number; w: number; h: number; pageIndex: number } | null>(null);
  const [processing, setProcessing] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const { pageZoom, onPageLoad } = usePageFit(containerRef, zoomLevel);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const pdfProxyRef = useRef<any>(null);

  const pdfBlobUrl = React.useMemo(() => {
    if (!rawPdfBytes) return null;
    return URL.createObjectURL(new Blob([rawPdfBytes as any], { type: 'application/pdf' }));
  }, [rawPdfBytes]);

  React.useEffect(() => {
    return () => {
      if (pdfBlobUrl) URL.revokeObjectURL(pdfBlobUrl);
    };
  }, [pdfBlobUrl]);

  // Metadata belongs to a specific PDF
  React.useEffect(() => setMetadata(null), [rawPdfBytes]);

  // Load metadata on tab switch
  React.useEffect(() => {
    if (activeTab === 'metadata' && rawPdfBytes && !metadata) {
      extractPDFMetadata(rawPdfBytes).then(setMetadata);
    }
  }, [activeTab, rawPdfBytes, metadata]);

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
    if (activeTab !== 'draw') return;
    const target = e.target as HTMLElement;
    if (target.closest('.delete-btn')) return;

    setIsDrawing(true);
    const { x, y } = getCoordinates(e, canvasEl);
    setStartX(x);
    setStartY(y);
    setCurrentBox({ x, y, w: 0, h: 0, pageIndex });
  };

  const handlePointerMove = (
    e: React.MouseEvent | React.TouchEvent,
    canvasEl: HTMLDivElement
  ) => {
    if (!isDrawing || !currentBox) return;
    const { x, y } = getCoordinates(e, canvasEl);
    setCurrentBox({
      ...currentBox,
      x: Math.min(startX, x),
      y: Math.min(startY, y),
      w: Math.abs(x - startX),
      h: Math.abs(y - startY),
    });
  };

  const handlePointerUp = () => {
    if (isDrawing && currentBox && currentBox.w > 1 && currentBox.h > 1) {
      crdt.addRedaction({
        pageIndex: currentBox.pageIndex,
        x: currentBox.x,
        y: currentBox.y,
        width: currentBox.w,
        height: currentBox.h,
        label: 'REDACTED',
      });
    }
    setIsDrawing(false);
    setCurrentBox(null);
  };

  // ponytail: matches within single pdf.js text items, horizontal text only; phrases split
  // across items or rotated text are missed. Upgrade: join items per line + map char offsets.
  const handleSearchWipe = async () => {
    const query = searchText.trim().toLowerCase();
    const pdf = pdfProxyRef.current;
    if (!query || !pdf) return;
    setIsSearching(true);
    let found = 0;
    try {
      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        for (const item of content.items as any[]) {
          if (!item.str) continue;
          const lower = item.str.toLowerCase();
          const [, , c, d, e, f] = item.transform;
          const fontH = Math.hypot(c, d) || item.height || 10;
          for (let idx = lower.indexOf(query); idx !== -1; idx = lower.indexOf(query, idx + query.length)) {
            const x0 = e + (item.width * idx) / item.str.length;
            const x1 = e + (item.width * (idx + query.length)) / item.str.length;
            const [vx0, vy0, vx1, vy1] = viewport.convertToViewportRectangle([x0, f - fontH * 0.25, x1, f + fontH]);
            const pad = 0.3;
            crdt.addRedaction({
              pageIndex: p - 1,
              x: (Math.min(vx0, vx1) / viewport.width) * 100 - pad,
              y: (Math.min(vy0, vy1) / viewport.height) * 100 - pad,
              width: (Math.abs(vx1 - vx0) / viewport.width) * 100 + 2 * pad,
              height: (Math.abs(vy1 - vy0) / viewport.height) * 100 + 2 * pad,
              label: 'WIPED: ' + searchText.trim(),
            });
            found++;
          }
        }
      }
    } catch (err) {
      alert('Text search failed: ' + err);
    } finally {
      setIsSearching(false);
    }
    if (!found) alert(`No matches for "${searchText.trim()}" (scanned/image-only text cannot be searched).`);
  };

  const handleExportRedacted = async () => {
    if (!rawPdfBytes) return;
    try {
      setProcessing(true);
      const redactedBytes = await buildConvergedPDF(rawPdfBytes, crdt.snapshot);
      const outputName = fileName.replace(/\.pdf$/i, '') + '-redacted.pdf';
      downloadUint8ArrayAsFile(redactedBytes, outputName);

      onDocumentProcessed({
        id: crypto.randomUUID(),
        name: outputName,
        action: 'Redacted',
        size: formatBytes(redactedBytes.byteLength),
        timestamp: Date.now(),
        timeAgo: 'Just now',
        blob: new Blob([redactedBytes as any], { type: 'application/pdf' }),
        documentId: documentId || undefined,
      });
    } catch (err) {
      alert('Error applying redaction: ' + err);
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
          <div className="w-14 h-14 rounded-2xl bg-marigold text-ink flex items-center justify-center mx-auto">
            <ShieldAlert className="w-6 h-6" />
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
              <Square className="w-3.5 h-3.5" />
              <span>Draw Box</span>
            </button>
            <button
              onClick={() => setActiveTab('wipe')}
              aria-pressed={activeTab === 'wipe'}
              className="segment"
            >
              <Search className="w-3.5 h-3.5" />
              <span>Search Wipe</span>
            </button>
            <button
              onClick={() => setActiveTab('metadata')}
              aria-pressed={activeTab === 'metadata'}
              className="segment"
            >
              <FileCode className="w-3.5 h-3.5" />
              <span>Metadata</span>
            </button>
          </div>

          {activeTab === 'wipe' && (
            <div className="flex items-center gap-2 pl-3 border-l border-ash">
              <input
                type="text"
                placeholder="Text to redact..."
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                aria-label="Text to redact"
                className="field h-[34px] w-44 rounded-full bg-cloud border-transparent text-caption px-3.5"
              />
              <button
                onClick={handleSearchWipe}
                disabled={isSearching}
                className="btn btn-primary h-[34px] px-3.5 text-caption"
              >
                {isSearching ? 'Wiping...' : 'Redact Matches'}
              </button>
            </div>
          )}

          <div className="chip bg-cloud tabular-nums ml-1">
            <span className="w-2.5 h-2.5 rounded-[3px] bg-ink" aria-hidden />
            {crdt.redactions.length} {crdt.redactions.length === 1 ? 'Redaction' : 'Redactions'}
          </div>
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
            onClick={handleExportRedacted}
            disabled={processing}
            className="btn btn-primary h-[34px] px-4 text-caption"
          >
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>{processing ? 'Sanitizing Pixels...' : 'Burn Redactions & Download'}</span>
          </button>
        </div>
      </div>

      {/* Main View Area */}
      {activeTab === 'metadata' ? (
        <div className="w-full max-w-2xl mx-auto px-4 py-10 space-y-6">
          <div className="bg-white rounded-3xl shadow-xl p-6 md:p-8 space-y-4">
            <h3 className="text-lg font-semibold tracking-[-0.3px] text-ink flex items-center gap-2.5">
              <span className="w-8 h-8 rounded-xl bg-marigold flex items-center justify-center shrink-0">
                <FileCode className="w-4 h-4" />
              </span>
              <span>Document Metadata to be Stripped</span>
            </h3>
            <p className="text-body-sm text-graphite">
              During export, EditorDoc P2P permanently removes all metadata tags, author info, and creator history.
            </p>
            {metadata ? (
              <div className="grid grid-cols-2 gap-4 text-caption font-mono text-ink bg-linen p-4 rounded-2xl">
                <div>
                  <span className="text-graphite">Title:</span> {metadata.title || 'None'}
                </div>
                <div>
                  <span className="text-graphite">Author:</span> {metadata.author || 'None'}
                </div>
                <div>
                  <span className="text-graphite">Subject:</span> {metadata.subject || 'None'}
                </div>
                <div>
                  <span className="text-graphite">Producer:</span> {metadata.producer || 'None'}
                </div>
                <div>
                  <span className="text-graphite">Creation Date:</span> {metadata.creationDate || 'None'}
                </div>
                <div>
                  <span className="text-graphite">Modified Date:</span> {metadata.modificationDate || 'None'}
                </div>
              </div>
            ) : (
              <div className="text-caption text-graphite">Reading metadata...</div>
            )}
          </div>
        </div>
      ) : (
        <div
          ref={containerRef}
          onPointerUp={handlePointerUp}
          className="flex-1 overflow-auto p-8 flex justify-center-safe items-start cursor-crosshair"
        >
          <Document
            file={pdfBlobUrl}
            onLoadSuccess={(pdf) => {
              pdfProxyRef.current = pdf;
              setNumPages(pdf.numPages);
            }}
            className="flex flex-col items-center space-y-8"
          >
            {Array.from({ length: numPages }, (_, pageIdx) => {
              const pageReds = crdt.redactions.filter((r) => r.pageIndex === pageIdx);

              return (
                <div
                  key={pageIdx}
                  ref={(el) => {
                    pageRefs.current[pageIdx] = el;
                  }}
                  className="relative bg-white shadow-xl rounded-lg select-none overflow-hidden"
                  style={{
                    zoom: pageZoom(pageIdx),
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
                    onLoadSuccess={(page) => onPageLoad(pageIdx, page)}
                    renderTextLayer={false}
                    renderAnnotationLayer={false}
                    className="pointer-events-none"
                  />

                  {/* Redaction boxes */}
                  {pageReds.map((r) => (
                    <div
                      key={r.id}
                      title={attributionTitle(r)}
                      className="absolute bg-black flex items-center justify-center text-white/50 text-[10px] font-mono tracking-widest border border-papaya/40 group"
                      style={{
                        left: `${r.x}%`,
                        top: `${r.y}%`,
                        width: `${r.width}%`,
                        height: `${r.height}%`,
                      }}
                    >
                      <span className="opacity-0 group-hover:opacity-100 transition-opacity">REDACTED</span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          crdt.removeRedaction(r.id);
                        }}
                        className="delete-btn opacity-0 group-hover:opacity-100 absolute -top-3 -right-3 w-5 h-5 bg-papaya text-white rounded-full flex items-center justify-center shadow-md-3 transition-opacity"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))}

                  {/* In-progress drawing box */}
                  {isDrawing && currentBox && currentBox.pageIndex === pageIdx && (
                    <div
                      className="absolute bg-black/80 border-2 border-papaya pointer-events-none flex items-center justify-center text-papaya text-[10px] font-mono"
                      style={{
                        left: `${currentBox.x}%`,
                        top: `${currentBox.y}%`,
                        width: `${currentBox.w}%`,
                        height: `${currentBox.h}%`,
                      }}
                    >
                      REDACTING
                    </div>
                  )}
                </div>
              );
            })}
          </Document>
        </div>
      )}
    </div>
  );
};
