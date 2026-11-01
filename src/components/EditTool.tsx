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
  Highlighter,
  Square,
  PenLine,
  MessageSquarePlus,
  MessagesSquare,
} from 'lucide-react';
import { AnnotationLayer, CommentsPanel, ANNOTATION_COLORS } from './Annotations';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import { useCRDTSync } from '../hooks/useCRDTSync';
import { usePageFit } from '../hooks/usePageFit';
import { SyncWaitingCard } from './SyncWaitingCard';
import type { Awareness } from 'y-protocols/awareness';
import { usePeers, attributionTitle, Peer, PresenceState } from '../lib/presence';

/** Live pointers of collaborators on one page. Own subscription: moves don't re-render the editor. */
const PeerCursors: React.FC<{ awareness: Awareness | null; pageIndex: number }> = ({ awareness, pageIndex }) => {
  const cursors = usePeers(awareness, (peers) =>
    peers
      .filter((p) => p.tool === 'edit' && p.cursor?.pageIndex === pageIndex)
      .map((p) => ({ id: p.clientId, name: p.user.name, color: p.user.color, x: p.cursor!.x, y: p.cursor!.y }))
  );
  return (
    <>
      {cursors.map((c) => (
        <div
          key={c.id}
          aria-hidden
          className="absolute z-20 pointer-events-none transition-[left,top] duration-100 ease-linear"
          style={{ left: `${c.x}%`, top: `${c.y}%` }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" style={{ color: c.color }}>
            <path d="M1 1l5.5 13 2-5.5L14 6.5z" fill="currentColor" stroke="white" strokeWidth="1" />
          </svg>
          <span
            className="absolute left-3.5 top-3.5 whitespace-nowrap text-[10px] font-semibold text-white px-1.5 py-0.5 rounded-full shadow-md-3"
            style={{ backgroundColor: c.color }}
          >
            {c.name}
          </span>
        </div>
      ))}
    </>
  );
};

/** overlay id -> collaborator who has it selected */
const selectPeerSelections = (peers: Peer[]) =>
  Object.fromEntries(
    peers.filter((p) => p.tool === 'edit' && p.selection).map((p) => [p.selection!, { name: p.user.name, color: p.user.color }])
  );

const PeerTag: React.FC<{ peer?: { name: string; color: string } }> = ({ peer }) =>
  peer ? (
    <span
      className="absolute -top-4 left-0 whitespace-nowrap text-[10px] font-semibold text-white px-1.5 rounded-full pointer-events-none"
      style={{ backgroundColor: peer.color }}
    >
      {peer.name}
    </span>
  ) : null;

const peerOutline = (peer?: { color: string }): React.CSSProperties =>
  peer ? { outline: `2px solid ${peer.color}`, outlineOffset: 1 } : {};

const FontSelect = ({ value, onChange }: { value: string; onChange: (val: string) => void }) => {
  const [isOpen, setIsOpen] = useState(false);
  const fonts = ['Helvetica', 'Arial', 'Verdana', 'Times New Roman', 'Georgia', 'Courier New'];
  const displayValue = value === 'TimesRoman' ? 'Times New Roman' : value === 'Courier' ? 'Courier New' : value;

  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        className="w-full h-[30px] bg-cloud hover:bg-ash rounded-full text-caption font-medium pl-3 pr-2 text-ink flex justify-between items-center transition-colors"
        onClick={() => setIsOpen(!isOpen)}
      >
        <span>{displayValue}</span>
        <ChevronDown className="w-3.5 h-3.5 text-graphite" />
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div className="absolute z-50 w-full mt-2 bg-white rounded-2xl shadow-md p-1.5" role="listbox">
            {fonts.map((f) => (
              <div
                key={f}
                role="option"
                aria-selected={displayValue === f}
                className={`px-2.5 py-1.5 rounded-xl text-caption cursor-pointer flex justify-between items-center transition-colors ${
                  displayValue === f ? 'bg-cloud text-ink font-medium' : 'text-graphite hover:bg-linen hover:text-ink'
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

type EditorMode = 'text' | 'eraser' | 'highlight' | 'box' | 'ink' | 'note';

const REVIEW_MODES: { mode: EditorMode; label: string; Icon: React.FC<{ className?: string }> }[] = [
  { mode: 'highlight', label: 'Highlight', Icon: Highlighter },
  { mode: 'box', label: 'Box', Icon: Square },
  { mode: 'ink', label: 'Draw', Icon: PenLine },
  { mode: 'note', label: 'Note', Icon: MessageSquarePlus },
];

/** Colour dot; the chosen one gets an Ink ring lifted off the toolbar. */
const swatch = (selected: boolean) =>
  `w-5 h-5 rounded-full transition-shadow ${selected ? 'ring-2 ring-ink ring-offset-2 ring-offset-white' : 'ring-1 ring-ink/15 hover:ring-ink/40'}`;
/** Pressed formatting toggles fill with Ink. */
const toggle = (on: boolean) => (on ? 'bg-ink text-white' : 'bg-cloud text-graphite hover:text-ink hover:bg-ash');

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
  const [activeTool, setActiveTool] = useState<EditorMode>('text');
  const isRectMode = activeTool === 'eraser' || activeTool === 'highlight' || activeTool === 'box';

  // Review markup
  const [annotationColor, setAnnotationColor] = useState(ANNOTATION_COLORS[0]);
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [focusReplyFor, setFocusReplyFor] = useState<string | null>(null);
  const [draftInk, setDraftInk] = useState<{ pageIndex: number; points: number[] } | null>(null);
  const commentCounts = React.useMemo(() => {
    const counts: Record<string, number> = {};
    for (const c of crdt.comments) counts[c.annotationId] = (counts[c.annotationId] ?? 0) + 1;
    return counts;
  }, [crdt.comments]);
  const openThread = (id: string, focusReply = false) => {
    setActiveAnnotationId(id);
    setActiveTextId(null);
    setPanelOpen(true);
    setFocusReplyFor(focusReply ? id : null);
  };
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

  // Presence: what we point at and select; what collaborators have selected
  const { setPresence, awareness } = crdt;
  const peerSelections = usePeers(awareness, selectPeerSelections);
  const selectedId = activeTextId ?? draggingEraserId ?? activeAnnotationId;
  useEffect(() => {
    setPresence({ selection: selectedId });
  }, [setPresence, awareness, selectedId]);

  // Cursor updates are coalesced: at most ~8 per second leave this tab
  const cursorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCursor = useRef<PresenceState['cursor']>(null);
  const publishCursor = (cursor: PresenceState['cursor']) => {
    pendingCursor.current = cursor;
    if (cursorTimer.current) return;
    cursorTimer.current = setTimeout(() => {
      cursorTimer.current = null;
      setPresence({ cursor: pendingCursor.current });
    }, 120);
  };
  useEffect(
    () => () => {
      if (cursorTimer.current) clearTimeout(cursorTimer.current);
      setPresence({ cursor: null, selection: null });
    },
    [setPresence]
  );

  const openThreads = crdt.annotations.filter((a) => !a.resolved && commentCounts[a.id]).length;

  // Undo or a peer may delete what we had selected
  useEffect(() => {
    if (activeAnnotationId && !crdt.annotations.some((a) => a.id === activeAnnotationId)) setActiveAnnotationId(null);
  }, [activeAnnotationId, crdt.annotations]);

  // Delete removes the selected markup (outside text fields)
  useEffect(() => {
    if (!activeAnnotationId) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        crdt.removeAnnotation(activeAnnotationId);
        setActiveAnnotationId(null);
      } else if (e.key === 'Escape') setActiveAnnotationId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeAnnotationId, crdt.removeAnnotation]);

  const containerRef = useRef<HTMLDivElement>(null);
  const { pageZoom, onPageLoad } = usePageFit(containerRef, zoomLevel);
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
    if (file && onUploadFile) onUploadFile(file);
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

    const annotationEl = target.closest('.annotation-node');
    if (annotationEl) {
      const id = annotationEl.getAttribute('data-id');
      if (id) {
        openThread(id);
        return;
      }
    }
    setActiveAnnotationId(null);

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
    if (isRectMode) {
      setIsDrawing(true);
      const { x, y } = getCoordinates(e, canvasEl);
      setStartX(x);
      setStartY(y);
      setCurrentBox({ x, y, w: 0, h: 0, pageIndex });
    } else if (activeTool === 'ink') {
      setIsDrawing(true);
      const { x, y } = getCoordinates(e, canvasEl);
      setDraftInk({ pageIndex, points: [x, y] });
    } else if (activeTool === 'note') {
      const { x, y } = getCoordinates(e, canvasEl);
      const id = crdt.addAnnotation({ type: 'note', pageIndex, x, y, width: 0, height: 0, color: annotationColor });
      if (id) openThread(id, true);
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

    if (isDrawing && activeTool === 'ink') {
      setDraftInk((d) => {
        if (!d) return d;
        const [lx, ly] = d.points.slice(-2);
        return Math.hypot(x - lx, y - ly) < 0.4 ? d : { ...d, points: [...d.points, x, y] };
      });
      return;
    }

    if (isDrawing && isRectMode && currentBox) {
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
    } else if (isDrawing && (activeTool === 'highlight' || activeTool === 'box') && currentBox && currentBox.w > 0.5 && currentBox.h > 0.5) {
      const id = crdt.addAnnotation({
        type: activeTool,
        pageIndex: currentBox.pageIndex,
        x: currentBox.x,
        y: currentBox.y,
        width: currentBox.w,
        height: currentBox.h,
        color: annotationColor,
      });
      if (id) setActiveAnnotationId(id);
    } else if (isDrawing && activeTool === 'ink' && draftInk && draftInk.points.length >= 4) {
      const xs = draftInk.points.filter((_, i) => i % 2 === 0);
      const ys = draftInk.points.filter((_, i) => i % 2 === 1);
      const [minX, minY] = [Math.min(...xs), Math.min(...ys)];
      const id = crdt.addAnnotation({
        type: 'ink',
        pageIndex: draftInk.pageIndex,
        x: minX,
        y: minY,
        width: Math.max(...xs) - minX,
        height: Math.max(...ys) - minY,
        color: annotationColor,
        points: draftInk.points.map((v) => Math.round(v * 100) / 100),
      });
      if (id) setActiveAnnotationId(id);
    }
    setIsDrawing(false);
    setCurrentBox(null);
    setDraftInk(null);
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
        <div className="bg-white/60 rounded-4xl border-2 border-dashed border-ink/15 p-12 space-y-4">
          <div className="w-14 h-14 rounded-2xl bg-mint text-ink flex items-center justify-center mx-auto">
            <Upload className="w-6 h-6" />
          </div>
          <h2 className="font-serif text-subheading text-ink">No PDF Active</h2>
          <p className="text-body-sm text-graphite max-w-sm mx-auto">
            Upload a PDF or return to the Dashboard to load the demo confidential agreement.
          </p>
          <label className="btn btn-primary cursor-pointer">
            <Upload className="w-4 h-4" />
            <span>Select PDF</span>
            <input type="file" accept="application/pdf" onChange={handleFileUpload} className="hidden" />
          </label>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-var(--header-h))]">
      {/* Top Controls Toolbar: a floating white bar on the canvas */}
      <div className="mx-4 md:mx-6 mt-1 bg-white rounded-3xl shadow-subtle pl-2 pr-2 py-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 z-30">
        <div className="flex flex-wrap items-center gap-2">
          {/* Tool switch */}
          <div className="segmented">
            <button onClick={() => setActiveTool('text')} aria-pressed={activeTool === 'text'} className="segment">
              <Type className="w-3.5 h-3.5" />
              <span>Text</span>
            </button>
            <button onClick={() => setActiveTool('eraser')} aria-pressed={activeTool === 'eraser'} className="segment">
              <Eraser className="w-3.5 h-3.5" />
              <span>Eraser</span>
            </button>
          </div>

          {/* Review markup */}
          <div className="segmented" role="group" aria-label="Review tools">
            {REVIEW_MODES.map(({ mode, label, Icon }) => (
              <button
                key={mode}
                onClick={() => setActiveTool(mode)}
                aria-pressed={activeTool === mode}
                title={label}
                className="segment px-2.5"
              >
                <Icon className="w-3.5 h-3.5" />
                <span className="hidden xl:inline">{label}</span>
              </button>
            ))}
          </div>

          {(activeTool === 'highlight' || activeTool === 'box' || activeTool === 'ink' || activeTool === 'note') && (
            <div className="flex items-center gap-1.5 pl-3 border-l border-ash" role="radiogroup" aria-label="Markup colour">
              {ANNOTATION_COLORS.map((c) => (
                <button
                  key={c}
                  role="radio"
                  aria-checked={annotationColor === c}
                  aria-label={c}
                  onClick={() => setAnnotationColor(c)}
                  className={swatch(annotationColor === c)}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          )}

          {/* Text options if active */}
          {activeTool === 'text' && (
            <div className="flex flex-wrap items-center gap-2 pl-3 border-l border-ash">
              <div className="w-36">
                <FontSelect
                  value={textStyle.fontFamily}
                  onChange={(f) => applyTextUpdate({ fontFamily: f as any })}
                />
              </div>

              <div className="flex items-center bg-cloud rounded-full p-0.5 text-caption">
                <button
                  onClick={() => applyTextUpdate({ fontSize: Math.max(8, textStyle.fontSize - 2) })}
                  className="w-[26px] h-[26px] rounded-full font-semibold text-graphite hover:text-ink hover:bg-white"
                  aria-label="Smaller text"
                >
                  -
                </button>
                <span className="tabular-nums font-medium w-6 text-center">{textStyle.fontSize}</span>
                <button
                  onClick={() => applyTextUpdate({ fontSize: Math.min(72, textStyle.fontSize + 2) })}
                  className="w-[26px] h-[26px] rounded-full font-semibold text-graphite hover:text-ink hover:bg-white"
                  aria-label="Larger text"
                >
                  +
                </button>
              </div>

              <button
                onClick={() => applyTextUpdate({ isBold: !textStyle.isBold })}
                aria-pressed={textStyle.isBold}
                aria-label="Bold"
                className={`w-[30px] h-[30px] rounded-full text-caption font-bold transition-colors ${toggle(textStyle.isBold)}`}
              >
                B
              </button>

              <button
                onClick={() => applyTextUpdate({ isItalic: !textStyle.isItalic })}
                aria-pressed={textStyle.isItalic}
                aria-label="Italic"
                className={`w-[30px] h-[30px] rounded-full text-body-sm italic font-serif transition-colors ${toggle(textStyle.isItalic)}`}
              >
                I
              </button>

              <div className="flex items-center gap-1.5 pl-1">
                {colors.slice(0, 6).map((c) => (
                  <button
                    key={c}
                    onClick={() => applyTextUpdate({ color: c })}
                    aria-label={`Text colour ${c}`}
                    className={swatch(textStyle.color === c)}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Eraser options */}
          {activeTool === 'eraser' && (
            <div className="flex items-center gap-2 pl-3 border-l border-ash">
              <span className="text-caption text-graphite">Color:</span>
              <div className="flex items-center gap-1.5">
                {['#ffffff', '#faf9f8', '#f4f3f2', '#1a1c1c'].map((c) => (
                  <button
                    key={c}
                    onClick={() => setEraserColor(c)}
                    aria-label={`Whiteout colour ${c}`}
                    className={swatch(eraserColor === c)}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right tools: Zoom, Pagination, Save */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center bg-cloud rounded-full p-0.5 text-caption">
            <button
              onClick={() => setZoomLevel((z) => Math.max(50, z - 10))}
              className="w-[26px] h-[26px] rounded-full flex items-center justify-center text-graphite hover:text-ink hover:bg-white"
              aria-label="Zoom out"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <span className="tabular-nums font-medium w-11 text-center">{zoomLevel}%</span>
            <button
              onClick={() => setZoomLevel((z) => Math.min(200, z + 10))}
              className="w-[26px] h-[26px] rounded-full flex items-center justify-center text-graphite hover:text-ink hover:bg-white"
              aria-label="Zoom in"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
          </div>

          <button
            onClick={() => setPanelOpen((o) => !o)}
            aria-pressed={panelOpen}
            className={`btn h-[34px] px-3.5 text-caption ${panelOpen ? 'bg-periwinkle text-ink' : 'btn-ghost'}`}
          >
            <MessagesSquare className="w-3.5 h-3.5" />
            <span>Comments{openThreads ? ` (${openThreads})` : ''}</span>
          </button>

          <button
            onClick={handleExportPDF}
            disabled={processing}
            className="btn btn-primary h-[34px] px-4 text-caption"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{processing ? 'Rendering...' : 'Save & Download'}</span>
          </button>
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
      {/* Canvas Viewport */}
      <div
        ref={containerRef}
        onPointerUp={handlePointerUp}
        className="flex-1 overflow-auto p-8 flex justify-center-safe items-start"
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
                className="relative bg-white shadow-xl rounded-lg select-none overflow-hidden"
                style={{
                  zoom: pageZoom(pageIdx),
                  touchAction: isRectMode || activeTool === 'ink' ? 'none' : undefined, // drawing, not scrolling
                }}
                onPointerDown={(e) => {
                  const targetCanvas = pageRefs.current[pageIdx];
                  if (targetCanvas) handlePointerDown(e, pageIdx, targetCanvas);
                }}
                onPointerMove={(e) => {
                  const targetCanvas = pageRefs.current[pageIdx];
                  if (!targetCanvas) return;
                  handlePointerMove(e, targetCanvas);
                  publishCursor({ pageIndex: pageIdx, ...getCoordinates(e, targetCanvas) });
                }}
                onPointerLeave={() => publishCursor(null)}
              >
                <Page
                  pageNumber={pageIdx + 1}
                  onLoadSuccess={(page) => onPageLoad(pageIdx, page)}
                  renderTextLayer={false}
                  renderAnnotationLayer={false}
                  className="pointer-events-none"
                />

                <AnnotationLayer
                  annotations={crdt.annotations.filter((a) => a.pageIndex === pageIdx)}
                  commentCounts={commentCounts}
                  selectedId={activeAnnotationId}
                  peerSelections={peerSelections}
                  draftInk={draftInk?.pageIndex === pageIdx ? draftInk.points : null}
                  draftColor={annotationColor}
                />

                {/* Whiteouts layer */}
                {pageWhiteouts.map((w) => (
                  <div
                    key={w.id}
                    data-id={w.id}
                    className="eraser-node absolute cursor-move border border-dashed border-ink/20 hover:border-ink/50 group"
                    title={attributionTitle(w)}
                    style={{
                      left: `${w.x}%`,
                      top: `${w.y}%`,
                      width: `${w.width}%`,
                      height: `${w.height}%`,
                      backgroundColor: w.color || '#ffffff',
                      ...peerOutline(peerSelections[w.id]),
                    }}
                  >
                    <PeerTag peer={peerSelections[w.id]} />
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        crdt.removeWhiteout(w.id);
                      }}
                      className="delete-btn opacity-0 group-hover:opacity-100 absolute -top-3 -right-3 w-5 h-5 bg-papaya text-white rounded-full flex items-center justify-center shadow-md-3 transition-opacity"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}

                {/* In-progress drawing whiteout box */}
                {isDrawing && currentBox && currentBox.pageIndex === pageIdx && (
                  <div
                    className="absolute pointer-events-none border"
                    style={{
                      left: `${currentBox.x}%`,
                      top: `${currentBox.y}%`,
                      width: `${currentBox.w}%`,
                      height: `${currentBox.h}%`,
                      ...(activeTool === 'eraser'
                        ? { backgroundColor: eraserColor, opacity: 0.8, borderColor: '#0087ff' }
                        : activeTool === 'highlight'
                          ? { backgroundColor: annotationColor, opacity: 0.35, borderColor: 'transparent' }
                          : { borderColor: annotationColor, borderWidth: 2 }),
                    }}
                  />
                )}

                {/* Text overlays layer */}
                {pageTexts.map((t) => (
                  <div
                    key={t.id}
                    data-id={t.id}
                    className={`text-overlay-node absolute cursor-move group px-1 py-0.5 rounded border transition-colors ${
                      activeTextId === t.id ? 'border-azure bg-azure/5' : 'border-transparent hover:border-ink/20'
                    }`}
                    title={attributionTitle(t)}
                    style={{
                      left: `${t.x}%`,
                      top: `${t.y}%`,
                      fontFamily: t.fontFamily || 'Helvetica',
                      fontSize: `${t.fontSize}px`,
                      fontWeight: t.isBold ? 'bold' : 'normal',
                      fontStyle: t.isItalic ? 'italic' : 'normal',
                      color: t.color || '#1a1c1c',
                      ...peerOutline(peerSelections[t.id]),
                    }}
                  >
                    <PeerTag peer={peerSelections[t.id]} />
                    <input
                      type="text"
                      value={t.text}
                      onChange={(e) => crdt.updateTextOverlay(t.id, { text: e.target.value })}
                      onFocus={() => setActiveTextId(t.id)}
                      className="bg-transparent outline-none border-b border-transparent focus:border-azure min-w-[60px]"
                      style={{ fontSize: 'inherit', color: 'inherit', fontFamily: 'inherit' }}
                    />
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        crdt.removeTextOverlay(t.id);
                      }}
                      className="delete-btn opacity-0 group-hover:opacity-100 absolute -top-3 -right-3 w-5 h-5 bg-papaya text-white rounded-full flex items-center justify-center shadow-md-3 transition-opacity"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}

                <PeerCursors awareness={awareness} pageIndex={pageIdx} />
              </div>
            );
          })}
        </Document>
      </div>

      {panelOpen && (
        <CommentsPanel
          annotations={crdt.annotations}
          comments={crdt.comments}
          selectedId={activeAnnotationId}
          focusReplyFor={focusReplyFor}
          peerSelections={peerSelections}
          onSelect={(id) => {
            setActiveAnnotationId(id);
            const a = crdt.annotations.find((x) => x.id === id);
            if (a) pageRefs.current[a.pageIndex]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
          }}
          onReply={crdt.addComment}
          onResolve={(id, resolved) => crdt.updateAnnotation(id, { resolved })}
          onDelete={(id) => {
            crdt.removeAnnotation(id);
            if (activeAnnotationId === id) setActiveAnnotationId(null);
          }}
          onDeleteComment={crdt.removeComment}
          onClose={() => setPanelOpen(false)}
        />
      )}
      </div>
    </div>
  );
};
