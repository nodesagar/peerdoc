import React, { useState, useRef, useEffect } from 'react';
import { ProcessedDoc, TextOverlay, Annotation } from '../types';
import { readDocumentSnapshot } from '../lib/crdt/schema';
import { eraseAnnotations, brushHitsRect, inkBounds, Pt } from '../lib/erase';
import { buildConvergedPDF, downloadUint8ArrayAsFile, formatBytes } from '../utils/pdfProcessor';
import {
  FileText,
  Upload,
  Check,
  Eraser,
  Type,
  TextCursorInput,
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
import { AnnotationLayer, CommentsPanel, ANNOTATION_COLORS, ANNOTATION_COLOR_NAMES, resizeRect, Handle } from './Annotations';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import { useCRDTSync } from '../hooks/useCRDTSync';
import { usePdfTextModel, useEditedPdf, EditedPage, TextEditLayer } from './PdfTextLayer';
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

/** Labelled range input for the tool options bar. */
const Slider: React.FC<{ label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }> = ({
  label,
  value,
  min,
  max,
  step,
  onChange,
}) => (
  <label className="flex items-center gap-2 pl-3 border-l border-ash text-caption text-graphite">
    <span>{label}</span>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-24 accent-ink"
    />
    <span className="tabular-nums font-medium text-ink w-6">{value}</span>
  </label>
);

type EditorMode = 'edit' | 'text' | 'eraser' | 'highlight' | 'box' | 'ink' | 'note';

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
  onSaveDocument?: (doc: ProcessedDoc) => void;
  rawPdfBytes: Uint8Array | null;
  documentId: string | null;
  fileName: string;
  crdt: ReturnType<typeof useCRDTSync>;
  onUploadFile?: (file: File) => void;
}

export const EditTool: React.FC<EditToolProps> = ({
  onDocumentProcessed,
  onSaveDocument,
  rawPdfBytes,
  documentId,
  fileName,
  crdt,
  onUploadFile,
}) => {
  // Editing the PDF's own text is the primary mode
  const [activeTool, setActiveTool] = useState<EditorMode>('edit');
  const isRectMode = activeTool === 'highlight' || activeTool === 'box';
  const isReviewMode = REVIEW_MODES.some((m) => m.mode === activeTool);
  const isDrawMode = isReviewMode || activeTool === 'eraser';
  // Whiteouts and added text let clicks through, so markup and the eraser work on top of them
  const passThrough = isDrawMode;

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
  // Pointer-to-item offset at grab time: moves place the item absolutely, so a move that lands
  // before React re-renders the CRDT state can't be lost (incremental deltas drifted).
  const grab = useRef({ dx: 0, dy: 0 });
  // Notes drop on release, not press: a touch scroll in Note mode cancels instead of pinning
  const pendingNote = useRef<{ pageIndex: number; x: number; y: number } | null>(null);
  // Markup being dragged: the item as grabbed + where the pointer was, so every move places it
  // absolutely from that origin. `moved` tells a drag from a click (click opens the thread).
  // `pin`: grabbed by its comment pin, so a click opens the thread (a click on the shape only selects)
  const annDrag = useRef<{ ann: Annotation; px: number; py: number; moved: boolean; pin: boolean } | null>(null);
  // Highlight/box being resized by one of its grips (rect as grabbed + which grip)
  const annResize = useRef<{ ann: Annotation; handle: Handle } | null>(null);
  // Eraser: brush diameter in % of page width, last brush point, per-page brush outline
  const [eraserSize, setEraserSize] = useState(4);
  const lastErase = useRef<Pt | null>(null);
  const brushRefs = useRef<(HTMLDivElement | null)[]>([]);
  // Box and Draw line width (pt)
  const [lineWidth, setLineWidth] = useState(2);

  const [processing, setProcessing] = useState(false);

  // Formatting state
  const [textStyle, setTextStyle] = useState({
    fontFamily: 'Helvetica',
    fontSize: 14,
    isBold: false,
    isItalic: false,
    color: '#1a1c1c',
  });

  // Selecting a box or drawing shows its line width on the slider, which then restyles it
  const selectedAnn = crdt.annotations.find((a) => a.id === activeAnnotationId);
  const selectedLined = selectedAnn && (selectedAnn.type === 'box' || selectedAnn.type === 'ink') ? selectedAnn : null;
  useEffect(() => {
    if (selectedLined?.strokeWidth) setLineWidth(selectedLined.strokeWidth);
  }, [selectedLined?.id, selectedLined?.strokeWidth]);
  const changeLineWidth = (w: number) => {
    setLineWidth(w);
    if (selectedLined) crdt.updateAnnotation(selectedLined.id, { strokeWidth: w });
  };

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

  // Pass a Blob to react-pdf so PDF.js reads a fresh ArrayBuffer copy without URL revocation issues in StrictMode
  const pdfFile = React.useMemo(() => {
    if (!rawPdfBytes) return null;
    return new Blob([rawPdfBytes as BlobPart], { type: 'application/pdf' });
  }, [rawPdfBytes]);

  // In-place text editing: runs of the original file, and the file as displayed with edits applied
  const textModel = usePdfTextModel(rawPdfBytes);
  const edited = useEditedPdf(rawPdfBytes, crdt.textEdits, numPages);
  const shownEditKeys = React.useMemo(() => edited.shown?.keys ?? new Set<string>(), [edited.shown]);

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

  const getCoordinates = (e: React.PointerEvent, canvasEl: HTMLDivElement) => {
    const rect = canvasEl.getBoundingClientRect();
    // Clamped: a captured pointer keeps reporting after it leaves the page
    const pct = (v: number) => Math.min(100, Math.max(0, v * 100));
    return { x: pct((e.clientX - rect.left) / rect.width), y: pct((e.clientY - rect.top) / rect.height) };
  };

  const handlePointerDown = (e: React.PointerEvent, pageIndex: number, canvasEl: HTMLDivElement) => {
    // Primary button / first finger only: right-click or a second finger must not draw or pin notes
    if (!e.isPrimary || e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.closest('.delete-btn')) {
      return;
    }
    // Keep the gesture on this page: moves elsewhere (another page, the toolbar, outside the
    // window) still report here, and the release always ends it.
    const capture = () => canvasEl.setPointerCapture(e.pointerId);

    // Markup: press to select, drag to move, click (no drag) opens its thread. The eraser rubs
    // markup out instead, so it skips this.
    const grip = target.closest('.resize-handle');
    const gripAnn = grip && crdt.annotations.find((a) => a.id === grip.getAttribute('data-id'));
    if (gripAnn) {
      annResize.current = { ann: gripAnn, handle: grip.getAttribute('data-handle') as Handle };
      capture();
      return;
    }

    const annId = activeTool !== 'eraser' && target.closest('.annotation-node')?.getAttribute('data-id');
    const ann = annId && crdt.annotations.find((a) => a.id === annId);
    if (ann) {
      const { x, y } = getCoordinates(e, canvasEl);
      annDrag.current = { ann, px: x, py: y, moved: false, pin: !!target.closest('.annotation-pin') };
      setActiveAnnotationId(ann.id);
      setActiveTextId(null);
      capture();
      return;
    }
    setActiveAnnotationId(null);

    const eraserId = target.closest('.eraser-node')?.getAttribute('data-id');
    const whiteout = eraserId && crdt.whiteouts.find((w) => w.id === eraserId);
    if (whiteout) {
      const { x, y } = getCoordinates(e, canvasEl);
      grab.current = { dx: x - whiteout.x, dy: y - whiteout.y };
      setDraggingEraserId(whiteout.id);
      setActiveTextId(null);
      capture();
      return;
    }

    const textId = target.closest('.text-overlay-node')?.getAttribute('data-id');
    const overlay = textId && crdt.textOverlays.find((t) => t.id === textId);
    if (overlay) {
      const { x, y } = getCoordinates(e, canvasEl);
      grab.current = { dx: x - overlay.x, dy: y - overlay.y };
      setDraggingTextId(overlay.id);
      setActiveTextId(overlay.id);
      setActiveTool('text');
      capture();
      return;
    }

    // Canvas click (in Edit text mode the text layer handles clicks)
    if (activeTool === 'edit') return;
    if (isRectMode) {
      setIsDrawing(true);
      const { x, y } = getCoordinates(e, canvasEl);
      setStartX(x);
      setStartY(y);
      setCurrentBox({ x, y, w: 0, h: 0, pageIndex });
      capture();
    } else if (activeTool === 'ink') {
      setIsDrawing(true);
      const { x, y } = getCoordinates(e, canvasEl);
      setDraftInk({ pageIndex, points: [x, y] });
      capture();
    } else if (activeTool === 'eraser') {
      setIsDrawing(true);
      const p = getCoordinates(e, canvasEl);
      lastErase.current = p;
      eraseAlong(pageIndex, p, p, canvasEl);
      capture();
    } else if (activeTool === 'note') {
      pendingNote.current = { pageIndex, ...getCoordinates(e, canvasEl) };
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

  /**
   * Rubs the brush from `a` to `b` over this page's markup: drawings are cut where it passes,
   * highlights, boxes and whiteouts it touches go. Reads the live doc, not React state: a
   * stroke split by the previous move must not be split again from a stale copy.
   */
  const eraseAlong = (pageIndex: number, a: Pt, b: Pt, canvasEl: HTMLDivElement) => {
    const doc = crdt.doc;
    if (!doc) return;
    const rect = canvasEl.getBoundingClientRect();
    const brush = { a, b, r: eraserSize / 2, aspect: rect.height / rect.width };
    const live = readDocumentSnapshot(doc);
    const { remove, update, add } = eraseAnnotations(
      live.annotations.filter((x) => x.pageIndex === pageIndex),
      brush
    );
    const whiteouts = live.whiteouts.filter((w) => w.pageIndex === pageIndex && brushHitsRect(w, brush));
    if (!remove.length && !update.length && !add.length && !whiteouts.length) return;
    doc.transact(() => {
      remove.forEach(crdt.removeAnnotation);
      update.forEach((u) => crdt.updateAnnotation(u.id, u.patch));
      add.forEach((x) => crdt.addAnnotation(x));
      whiteouts.forEach((w) => crdt.removeWhiteout(w.id));
    });
  };

  /** Brush outline follows the pointer (DOM directly: hover must not re-render every page). */
  const showBrush = (pageIndex: number, p: Pt | null) => {
    const el = brushRefs.current[pageIndex];
    if (!el) return;
    el.style.display = p ? 'block' : 'none';
    if (p) {
      el.style.left = `${p.x}%`;
      el.style.top = `${p.y}%`;
    }
  };

  const handlePointerMove = (e: React.PointerEvent, pageIndex: number, canvasEl: HTMLDivElement) => {
    const { x, y } = getCoordinates(e, canvasEl);
    const within = (v: number, max: number) => Math.min(max, Math.max(0, v));

    if (activeTool === 'eraser') showBrush(pageIndex, { x, y });

    const resize = annResize.current;
    if (resize) {
      crdt.updateAnnotation(resize.ann.id, resizeRect(resize.ann, resize.handle, { x, y }));
      return;
    }

    const drag = annDrag.current;
    if (drag) {
      const { ann } = drag;
      // A few tenths of a percent of jitter is still a click
      if (!drag.moved && Math.hypot(x - drag.px, y - drag.py) < 0.5) return;
      drag.moved = true;
      const nx = within(ann.x + x - drag.px, 100 - ann.width);
      const ny = within(ann.y + y - drag.py, 100 - ann.height);
      crdt.updateAnnotation(ann.id, {
        x: nx,
        y: ny,
        ...(ann.points && {
          points: ann.points.map((v, i) => Math.round((v + (i % 2 ? ny - ann.y : nx - ann.x)) * 100) / 100),
        }),
      });
      return;
    }

    if (draggingTextId) {
      // ponytail: overlay width unknown here, 95% keeps a grabbable sliver on the page
      crdt.updateTextOverlay(draggingTextId, { x: within(x - grab.current.dx, 95), y: within(y - grab.current.dy, 95) });
      return;
    }

    if (draggingEraserId) {
      const w = crdt.whiteouts.find((b) => b.id === draggingEraserId);
      if (w) {
        crdt.updateWhiteout(draggingEraserId, {
          x: within(x - grab.current.dx, 100 - w.width),
          y: within(y - grab.current.dy, 100 - w.height),
        });
      }
      return;
    }

    if (isDrawing && activeTool === 'eraser' && lastErase.current) {
      eraseAlong(pageIndex, lastErase.current, { x, y }, canvasEl);
      lastErase.current = { x, y };
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

  /** Drops any gesture in progress without committing it (pointercancel: scroll took over, etc.). */
  const resetGesture = () => {
    pendingNote.current = null;
    annDrag.current = null;
    annResize.current = null;
    lastErase.current = null;
    setDraggingTextId(null);
    setDraggingEraserId(null);
    setIsDrawing(false);
    setCurrentBox(null);
    setDraftInk(null);
  };

  const handlePointerUp = () => {
    const note = pendingNote.current;
    const drag = annDrag.current;
    if (note) {
      const id = crdt.addAnnotation({ type: 'note', ...note, width: 0, height: 0, color: annotationColor });
      if (id) openThread(id, true);
    } else if (drag) {
      // Selecting markup to move or resize must not pop the panel open (that re-fits the page
      // under the pointer); the pin is the way into the thread. An open panel follows selection.
      if (!drag.moved && drag.pin) openThread(drag.ann.id);
    } else if (isDrawing && isRectMode && currentBox && currentBox.w > 0.5 && currentBox.h > 0.5) {
      const id = crdt.addAnnotation({
        type: activeTool as 'highlight' | 'box',
        pageIndex: currentBox.pageIndex,
        x: currentBox.x,
        y: currentBox.y,
        width: currentBox.w,
        height: currentBox.h,
        color: annotationColor,
        ...(activeTool === 'box' && { strokeWidth: lineWidth }),
      });
      if (id) setActiveAnnotationId(id);
    } else if (isDrawing && activeTool === 'ink' && draftInk && draftInk.points.length >= 4) {
      const points = draftInk.points.map((v) => Math.round(v * 100) / 100);
      const id = crdt.addAnnotation({
        type: 'ink',
        pageIndex: draftInk.pageIndex,
        ...inkBounds(points),
        color: annotationColor,
        points,
        strokeWidth: lineWidth,
      });
      if (id) setActiveAnnotationId(id);
    }
    resetGesture();
  };

  const applyTextUpdate = (updates: Partial<TextOverlay>) => {
    setTextStyle((prev) => ({ ...prev, ...updates }));
    if (activeTextId) {
      crdt.updateTextOverlay(activeTextId, updates);
    }
  };

  const handleSavePDF = async () => {
    if (!rawPdfBytes) return;
    try {
      setProcessing(true);
      const convergedBytes = await buildConvergedPDF(rawPdfBytes, crdt.snapshot);
      const docRecord: ProcessedDoc = {
        id: documentId || crypto.randomUUID(),
        name: fileName,
        action: 'Edited',
        size: formatBytes(convergedBytes.byteLength),
        timestamp: Date.now(),
        timeAgo: 'Just now',
        blob: new Blob([convergedBytes as any], { type: 'application/pdf' }),
        documentId: documentId || undefined,
        format: 'pdf',
        pageCount: numPages,
        tool: 'edit',
      };
      if (onSaveDocument) {
        onSaveDocument(docRecord);
      } else {
        onDocumentProcessed(docRecord);
      }
    } catch (err) {
      console.error('Failed to save edited PDF:', err);
      alert('Error saving PDF from CRDT state: ' + err);
    } finally {
      setProcessing(false);
    }
  };

  const handleDownloadPDF = async () => {
    if (!rawPdfBytes) return;
    try {
      setProcessing(true);
      const convergedBytes = await buildConvergedPDF(rawPdfBytes, crdt.snapshot);
      const outputName = fileName.replace(/\.pdf$/i, '') + '-edited.pdf';
      downloadUint8ArrayAsFile(convergedBytes, outputName);
    } catch (err) {
      console.error('Failed to download edited PDF:', err);
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
    <div className="flex flex-col workspace-h">
      {/* Top Controls Toolbar: a floating white bar on the canvas */}
      <div className="mx-4 md:mx-6 mt-1 bg-white rounded-3xl shadow-subtle pl-2 pr-2 py-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 z-30">
        <div className="flex flex-wrap items-center gap-2">
          {/* Tool switch */}
          <div className="segmented">
            <button onClick={() => setActiveTool('edit')} aria-pressed={activeTool === 'edit'} className="segment" title="Click any text in the PDF to edit it in place">
              <TextCursorInput className="w-3.5 h-3.5" />
              <span>Edit text</span>
            </button>
            <button onClick={() => setActiveTool('text')} aria-pressed={activeTool === 'text'} className="segment" title="Click on the page to add text that matches the text around it">
              <Type className="w-3.5 h-3.5" />
              <span>Add text</span>
            </button>
            <button onClick={() => setActiveTool('eraser')} aria-pressed={activeTool === 'eraser'} className="segment" title="Rub out drawings, highlights and boxes">
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

          {isReviewMode && (
            <div className="flex items-center gap-1.5 pl-3 border-l border-ash" role="radiogroup" aria-label="Markup color">
              {ANNOTATION_COLORS.map((c) => (
                <button
                  key={c}
                  role="radio"
                  aria-checked={annotationColor === c}
                  aria-label={ANNOTATION_COLOR_NAMES[c] ?? c}
                  onClick={() => setAnnotationColor(c)}
                  className={swatch(annotationColor === c)}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          )}

          {/* Text options if active */}
          {activeTool === 'text' && activeTextId && (
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

          {activeTool === 'eraser' && (
            <Slider label="Size" value={eraserSize} min={2} max={12} step={1} onChange={setEraserSize} />
          )}

          {(activeTool === 'box' || activeTool === 'ink' || selectedLined) && (
            <Slider label="Line" value={lineWidth} min={1} max={12} step={0.5} onChange={changeLineWidth} />
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
            onClick={handleSavePDF}
            disabled={processing}
            className="btn btn-secondary h-[34px] px-4 text-caption"
            title="Save document to cache and end active session"
          >
            <Check className="w-3.5 h-3.5" />
            <span>{processing ? 'Saving...' : 'Save'}</span>
          </button>

          <button
            onClick={handleDownloadPDF}
            disabled={processing}
            className="btn btn-primary h-[34px] px-4 text-caption"
            title="Download PDF to your device (keeps document open in workspace)"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{processing ? 'Rendering...' : 'Download'}</span>
          </button>
        </div>
      </div>

      <div className="relative flex-1 flex min-h-0">
      {/* Canvas Viewport */}
      <div
        ref={containerRef}
        onPointerUp={handlePointerUp}
        onPointerCancel={resetGesture}
        className="flex-1 overflow-auto p-8 flex justify-center-safe items-start"
      >
        <Document
          file={pdfFile}
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
                  touchAction: isDrawMode && activeTool !== 'note' ? 'none' : undefined, // drawing, not scrolling
                  cursor: activeTool === 'eraser' ? 'none' : isDrawMode ? 'crosshair' : undefined, // eraser shows its brush
                }}
                onPointerDown={(e) => {
                  const targetCanvas = pageRefs.current[pageIdx];
                  if (targetCanvas) handlePointerDown(e, pageIdx, targetCanvas);
                }}
                onPointerMove={(e) => {
                  const targetCanvas = pageRefs.current[pageIdx];
                  if (!targetCanvas) return;
                  handlePointerMove(e, pageIdx, targetCanvas);
                  publishCursor({ pageIndex: pageIdx, ...getCoordinates(e, targetCanvas) });
                }}
                onPointerLeave={() => {
                  publishCursor(null);
                  showBrush(pageIdx, null);
                }}
              >
                <EditedPage
                  pageIndex={pageIdx}
                  shown={edited.shown}
                  next={edited.next}
                  onRendered={edited.onRendered}
                  onLoadSuccess={(page) => onPageLoad(pageIdx, page)}
                />

                <TextEditLayer
                  pageIndex={pageIdx}
                  model={textModel?.[pageIdx]}
                  edits={crdt.textEdits.filter((t) => t.pageIndex === pageIdx)}
                  shownKeys={shownEditKeys}
                  mode={activeTool === 'edit' ? 'edit' : activeTool === 'text' ? 'insert' : 'off'}
                  onUpsert={crdt.upsertTextEdit}
                  onRemove={crdt.removeTextEdit}
                />

                {/* Whiteouts layer: under the markup, as the export draws them. In review
                    modes they let clicks through so markup can go on top of them. */}
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
                      pointerEvents: passThrough ? 'none' : undefined,
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

                <AnnotationLayer
                  annotations={crdt.annotations.filter((a) => a.pageIndex === pageIdx)}
                  commentCounts={commentCounts}
                  selectedId={activeAnnotationId}
                  peerSelections={peerSelections}
                  draftInk={draftInk?.pageIndex === pageIdx ? draftInk.points : null}
                  draftColor={annotationColor}
                  draftWidth={lineWidth}
                  resizable={activeTool !== 'eraser'}
                />

                {/* In-progress drawing whiteout box */}
                {isDrawing && currentBox && currentBox.pageIndex === pageIdx && (
                  <div
                    className="absolute pointer-events-none border"
                    style={{
                      left: `${currentBox.x}%`,
                      top: `${currentBox.y}%`,
                      width: `${currentBox.w}%`,
                      height: `${currentBox.h}%`,
                      ...(activeTool === 'highlight'
                        ? { backgroundColor: annotationColor, opacity: 0.35, borderColor: 'transparent' }
                        : { borderColor: annotationColor, borderWidth: lineWidth }),
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
                      pointerEvents: passThrough ? 'none' : undefined, // mark up over it, don't grab it
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

                {activeTool === 'eraser' && (
                  <div
                    ref={(el) => {
                      brushRefs.current[pageIdx] = el;
                    }}
                    aria-hidden
                    className="absolute z-30 pointer-events-none rounded-full border-2 border-ink/60 bg-white/40 -translate-x-1/2 -translate-y-1/2"
                    style={{ width: `${eraserSize}%`, aspectRatio: '1', display: 'none' }}
                  />
                )}

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
