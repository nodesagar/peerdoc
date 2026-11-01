import React, { useEffect, useMemo, useRef, useState } from 'react';
import { EditorView } from 'prosemirror-view';
import { TextSelection, Command } from 'prosemirror-state';
import {
  addRowBefore,
  addRowAfter,
  addColumnBefore,
  addColumnAfter,
  deleteRow,
  deleteColumn,
  deleteTable,
  mergeCells,
  splitCell,
} from 'prosemirror-tables';
import { yXmlFragmentToProsemirrorJSON } from 'y-prosemirror';
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Superscript,
  Subscript,
  TextAlignStart,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignJustify,
  List,
  ListOrdered,
  ListIndentIncrease,
  ListIndentDecrease,
  Table,
  Image as ImageIcon,
  Link,
  Download,
  Printer,
  ZoomIn,
  ZoomOut,
  ListTree,
  RemoveFormatting,
  Highlighter,
  Baseline,
  SeparatorHorizontal,
  TableCellsMerge,
  TableCellsSplit,
  Trash2,
  ChevronDown,
  FileWarning,
  BetweenHorizontalStart,
  BetweenHorizontalEnd,
  BetweenVerticalStart,
  BetweenVerticalEnd,
} from 'lucide-react';
import { ProcessedDoc } from '../types';
import { useCRDTSync } from '../hooks/useCRDTSync';
import { SyncWaitingCard } from './SyncWaitingCard';
import { formatBytes } from '../utils/pdfProcessor';
import { WORD_BODY } from '../lib/crdt/schema';
import { loadWordPackage, WordPackage } from '../lib/word/package';
import { exportDocx } from '../lib/word/export';
import { editableParts, fragmentFor } from '../lib/word/seed';
import { wordSchema, WordNodeJSON, HIGHLIGHT_CSS } from '../lib/word/schema';
import {
  createWordEditor,
  setMark,
  markActive,
  setParagraphAttrs,
  selectedParagraphs,
  toggleListCommand,
  indentCommand,
  insertPageBreak,
  insertTableCommand,
  insertImageCommand,
  isInTable,
} from '../lib/word/editor';
import './word.css';

const M = wordSchema.marks;

const FONTS = ['Calibri', 'Cambria', 'Aptos', 'Arial', 'Helvetica', 'Times New Roman', 'Georgia', 'Garamond', 'Verdana', 'Segoe UI', 'Courier New'];
const SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72];
const TEXT_COLORS = ['000000', '595959', 'C00000', 'FF0000', 'ED7D31', 'FFC000', '70AD47', '00B050', '00B0F0', '0070C0', '002060', '7030A0'];
const HIGHLIGHTS = ['yellow', 'green', 'cyan', 'magenta', 'red', 'blue', 'lightGray', 'darkYellow'];

interface Formatting {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  sup: boolean;
  sub: boolean;
  font: string;
  size: number;
  align: string;
  style: string;
  list: string | null;
  inTable: boolean;
  link: string | null;
}

/** What the toolbar shows: the computed look at the caret (styles included), overridden by pending marks. */
function readFormatting(view: EditorView, pkg: WordPackage): Formatting {
  const { state } = view;
  const at = view.domAtPos(state.selection.head);
  const el = (at.node.nodeType === 1 ? at.node : at.node.parentElement) as HTMLElement | null;
  const cs = el ? getComputedStyle(el) : null;
  const stored = state.storedMarks;
  const storedAttr = (name: keyof typeof M) => stored && M[name].isInSet(stored)?.attrs;
  const para = selectedParagraphs(state)[0]?.node;
  const u = markActive(state, M.underline);
  const va = markActive(state, M.vertAlign)?.attrs.val;
  const sizeAttr = storedAttr('size');
  const fontAttr = storedAttr('font');
  return {
    bold: storedAttr('bold') ? storedAttr('bold')!.on !== false : Number(cs?.fontWeight) >= 600,
    italic: storedAttr('italic') ? storedAttr('italic')!.on !== false : cs?.fontStyle === 'italic',
    underline: !!u && u.attrs.val !== 'none',
    strike: !!markActive(state, M.strike),
    sup: va === 'superscript',
    sub: va === 'subscript',
    font: fontAttr?.family ?? (cs?.fontFamily.split(',')[0].replace(/["']/g, '').trim() || ''),
    size: sizeAttr ? sizeAttr.halfPts / 2 : cs ? Math.round(parseFloat(cs.fontSize) * 0.75 * 2) / 2 : 11,
    align: para?.attrs.align ?? 'left',
    style: para?.attrs.style ?? pkg.styles.defaultParagraph ?? '',
    list: para?.attrs.numId && para.attrs.numId !== '0' ? para.attrs.numId : null,
    inTable: isInTable(state),
    link: markActive(state, M.link)?.attrs.href ?? null,
  };
}

const iconBtn = (on = false) =>
  `inline-flex items-center justify-center w-[30px] h-[30px] rounded-lg transition-colors disabled:opacity-35 ${
    on ? 'bg-ink text-white' : 'text-graphite hover:text-ink hover:bg-cloud'
  }`;
const selectCls =
  'h-[30px] rounded-lg bg-cloud hover:bg-ash text-caption font-medium text-ink pl-2.5 pr-7 appearance-none bg-no-repeat transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-azure';
const Divider = () => <span aria-hidden className="w-px h-5 bg-ash mx-1" />;

/** Toolbar button that keeps the editor's selection (no focus steal). */
const ToolButton: React.FC<{ label: string; on?: boolean; disabled?: boolean; onRun: () => void; children: React.ReactNode }> = ({
  label,
  on,
  disabled,
  onRun,
  children,
}) => (
  <button
    type="button"
    title={label}
    aria-label={label}
    aria-pressed={on}
    disabled={disabled}
    onMouseDown={(e) => e.preventDefault()}
    onClick={onRun}
    className={iconBtn(on)}
  >
    {children}
  </button>
);

const Popover: React.FC<{ label: string; button: React.ReactNode; children: (close: () => void) => React.ReactNode }> = ({ label, button, children }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        title={label}
        aria-label={label}
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
        className={`${iconBtn(open)} w-auto px-1.5 gap-0.5`}
      >
        {button}
        <ChevronDown className="w-3 h-3 opacity-60" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onMouseDown={() => setOpen(false)} />
          <div className="absolute z-50 mt-2 right-0 w-max bg-white rounded-2xl shadow-md p-2.5" onMouseDown={(e) => e.preventDefault()}>
            {children(() => setOpen(false))}
          </div>
        </>
      )}
    </div>
  );
};

const TableGridPicker: React.FC<{ onPick: (rows: number, cols: number) => void }> = ({ onPick }) => {
  const [hover, setHover] = useState<[number, number]>([0, 0]);
  return (
    <div>
      <div className="grid grid-cols-8 gap-[3px]" onMouseLeave={() => setHover([0, 0])}>
        {Array.from({ length: 48 }, (_, i) => {
          const r = Math.floor(i / 8) + 1;
          const c = (i % 8) + 1;
          const on = r <= hover[0] && c <= hover[1];
          return (
            <button
              key={i}
              type="button"
              aria-label={`${r} by ${c} table`}
              onMouseEnter={() => setHover([r, c])}
              onFocus={() => setHover([r, c])}
              onClick={() => onPick(r, c)}
              className={`w-4 h-4 rounded-[3px] border ${on ? 'bg-azure/20 border-azure' : 'bg-white border-ash'}`}
            />
          );
        })}
      </div>
      <div className="text-caption text-graphite mt-2 text-center tabular-nums">{hover[0] ? `${hover[1]} × ${hover[0]} table` : 'Insert table'}</div>
    </div>
  );
};

interface WordEditorProps {
  onDocumentProcessed: (doc: ProcessedDoc) => void;
  /** Original file (DOCX or DOC); the template for export */
  bytes: Uint8Array | null;
  documentId: string | null;
  fileName: string;
  crdt: ReturnType<typeof useCRDTSync>;
  onUploadFile?: (file: File) => void;
}

export const WordEditor: React.FC<WordEditorProps> = ({ onDocumentProcessed, bytes, documentId, fileName, crdt, onUploadFile }) => {
  const opened = useMemo((): { pkg: WordPackage | null; error: string | null } => {
    if (!bytes) return { pkg: null, error: null };
    try {
      return { pkg: loadWordPackage(bytes), error: null };
    } catch (err) {
      return { pkg: null, error: err instanceof Error ? err.message : String(err) };
    }
  }, [bytes]);
  const pkg = opened.pkg;
  useEffect(() => () => pkg?.dispose(), [pkg]);

  // The body arrives with the seed (or from peers); mount editors only once it exists
  // Undo/redo buttons live in the app header (same per-user history)
  const { doc, awareness, undo, redo, trackUndo } = crdt;
  const [hasBody, setHasBody] = useState(false);
  useEffect(() => {
    if (!doc) return setHasBody(false);
    const body = doc.getXmlFragment(WORD_BODY);
    const check = () => setHasBody(body.length > 0);
    check();
    doc.on('update', check);
    return () => doc.off('update', check);
  }, [doc]);

  const bodyRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const viewsRef = useRef<{ part: string; view: EditorView }[]>([]);
  const activeRef = useRef<EditorView | null>(null);
  const [tick, setTick] = useState(0);
  const [zoom, setZoom] = useState(100);
  const customZoom = useRef(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [hfParts, setHfParts] = useState<{ header: boolean; footer: boolean }>({ header: false, footer: false });
  const imageInput = useRef<HTMLInputElement>(null);

  const [fitTick, setFitTick] = useState(0);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pkg) return;
    customZoom.current = false;

    const updateFit = () => {
      const availableWidth = Math.max(1, canvas.clientWidth - 32);
      const nextFit = Math.min(100, Math.floor((availableWidth / pkg.section.width) * 100));
      if (!customZoom.current) setZoom((current) => (current === nextFit ? current : nextFit));
    };

    updateFit();
    const observer = new ResizeObserver(updateFit);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [pkg, fitTick]);

  const setManualZoom = (nextZoom: number) => {
    customZoom.current = true;
    setZoom(nextZoom);
  };

  const contentWidth = pkg ? pkg.section.width - pkg.section.left - pkg.section.right : 600;

  const insertImageFile = (view: EditorView, file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const src = String(reader.result);
      const img = new Image();
      img.onload = () => {
        insertImageCommand(src, img.naturalWidth || 200, img.naturalHeight || 150, contentWidth)(view.state, view.dispatch);
        view.focus();
      };
      img.src = src;
    };
    reader.readAsDataURL(file);
  };
  const insertImageRef = useRef(insertImageFile);
  insertImageRef.current = insertImageFile;

  useEffect(() => {
    if (!doc || !pkg || !hasBody) return;
    const views: { part: string; view: EditorView }[] = [];
    const mountFor = (part: string) => (part === pkg.main ? bodyRef.current : part === pkg.headerPart ? headerRef.current : footerRef.current);
    for (const part of editableParts(pkg)) {
      const mount = mountFor(part);
      const fragment = doc.getXmlFragment(fragmentFor(pkg, part));
      if (!mount || fragment.length === 0) continue;
      if (part !== pkg.main) trackUndo(fragment);
      const view = createWordEditor({
        mount,
        fragment,
        pkg,
        part,
        awareness: part === pkg.main ? awareness : null,
        undo,
        redo,
        onUpdate: (v) => {
          if (v.hasFocus()) activeRef.current = v;
          setTick((t) => t + 1);
        },
        onFocus: (v) => {
          activeRef.current = v;
          setTick((t) => t + 1);
        },
        onImageFile: (v, f) => insertImageRef.current(v, f),
      });
      views.push({ part, view });
    }
    viewsRef.current = views;
    activeRef.current = views[0]?.view ?? null;
    setHfParts({
      header: views.some((v) => v.part === pkg.headerPart),
      footer: views.some((v) => v.part === pkg.footerPart),
    });
    setTick((t) => t + 1);
    return () => {
      for (const { view } of views) view.destroy();
      viewsRef.current = [];
      activeRef.current = null;
    };
  }, [doc, pkg, hasBody, awareness, undo, redo, trackUndo]);

  const active = activeRef.current;
  const fmt = useMemo(() => (active && pkg ? readFormatting(active, pkg) : null), [active, pkg, tick]);
  const bodyView = viewsRef.current.find((v) => v.part === pkg?.main)?.view ?? null;

  const outline = useMemo(() => {
    if (!bodyView || !pkg) return [];
    const items: { pos: number; level: number; text: string }[] = [];
    bodyView.state.doc.descendants((node, pos) => {
      if (node.type.name !== 'paragraph') return node.type.name !== 'table';
      const level = pkg.styles.byId.get(node.attrs.style)?.outline;
      if (level != null && node.textContent.trim()) items.push({ pos, level, text: node.textContent.trim() });
      return false;
    });
    return items;
  }, [bodyView, pkg, tick]);

  const stats = useMemo(() => {
    const text = bodyView?.state.doc.textBetween(0, bodyView.state.doc.content.size, ' ', ' ') ?? '';
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    return { words, chars: text.replace(/\s/g, '').length };
  }, [bodyView, tick]);

  const run = (cmd: Command) => {
    const v = activeRef.current;
    if (!v) return;
    cmd(v.state, v.dispatch, v);
    v.focus();
  };

  const toggleBold = (on: boolean) => run(setMark(M.bold, { on: !on }));
  const toggleItalic = (on: boolean) => run(setMark(M.italic, { on: !on }));

  const editLink = () => {
    const v = activeRef.current;
    if (!v) return;
    const href = window.prompt('Link address (leave empty to remove the link)', fmt?.link ?? 'https://');
    if (href === null) return;
    const { empty } = v.state.selection;
    if (!href.trim()) return run(setMark(M.link, null));
    if (empty) {
      const node = wordSchema.text(href, [M.link.create({ href }), M.rstyle.create({ id: 'Hyperlink' })]);
      v.dispatch(v.state.tr.replaceSelectionWith(node, false));
      v.focus();
      return;
    }
    run((state, dispatch) => {
      const { from, to } = state.selection;
      dispatch?.(state.tr.removeMark(from, to, M.link).addMark(from, to, M.link.create({ href })).addMark(from, to, M.rstyle.create({ id: 'Hyperlink' })));
      return true;
    });
  };

  const clearFormatting = () =>
    run((state, dispatch) => {
      const { from, to } = state.selection;
      const tr = state.tr;
      for (const m of Object.values(M)) if (m !== M.link) tr.removeMark(from, to, m);
      tr.setStoredMarks([]);
      dispatch?.(tr);
      return true;
    });

  const handleDownload = () => {
    if (!pkg || !doc) return;
    try {
      const parts: Record<string, WordNodeJSON> = {};
      for (const part of editableParts(pkg)) {
        const view = viewsRef.current.find((v) => v.part === part)?.view;
        const fragment = doc.getXmlFragment(fragmentFor(pkg, part));
        if (view) parts[part] = view.state.doc.toJSON() as WordNodeJSON;
        else if (fragment.length) parts[part] = yXmlFragmentToProsemirrorJSON(fragment) as WordNodeJSON;
      }
      const out = exportDocx(pkg, { parts });
      const name = `${fileName.replace(/\.(docx?|pdf)$/i, '')}-edited.docx`;
      const blob = new Blob([out as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      onDocumentProcessed({
        id: crypto.randomUUID(),
        name,
        action: 'Edited',
        size: formatBytes(out.byteLength),
        timestamp: Date.now(),
        timeAgo: 'Just now',
        blob,
        documentId: documentId || undefined,
      });
    } catch (err) {
      console.error('Word export failed:', err);
      alert('Could not build the Word file: ' + (err instanceof Error ? err.message : err));
    }
  };

  const handlePrint = () => {
    if (!pkg) return;
    const style = document.createElement('style');
    const mm = (px: number) => `${((px / 96) * 25.4).toFixed(1)}mm`;
    style.textContent = `@page { size: ${mm(pkg.section.width)} ${mm(pkg.section.height)}; margin: 0 }`;
    document.head.append(style);
    window.print();
    setTimeout(() => style.remove(), 0);
  };

  if (!bytes) {
    return (
      <SyncWaitingCard
        documentId={documentId || ''}
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

  if (opened.error || !pkg) {
    return (
      <div className="max-w-xl mx-auto px-4 py-16 text-center space-y-3">
        <div className="w-12 h-12 rounded-2xl bg-marigold text-ink flex items-center justify-center mx-auto">
          <FileWarning className="w-5 h-5" />
        </div>
        <h2 className="font-serif text-subheading text-ink">This Word file could not be opened</h2>
        <p className="text-body-sm text-graphite">{opened.error}</p>
      </div>
    );
  }

  const section = pkg.section;
  const styleOptions = pkg.styles.paragraphStyles.filter((s) => s.quick || s.id === fmt?.style);
  for (const id of ['Normal', 'Title', 'Heading1', 'Heading2', 'Heading3']) {
    if (!styleOptions.some((s) => s.id === id)) styleOptions.push({ id, name: id.replace(/(\d)$/, ' $1'), type: 'paragraph', basedOn: null, next: null, outline: null, quick: true, numId: null, ilvl: 0 });
  }
  const fontOptions = [...new Set([fmt?.font, pkg.theme.minor, pkg.theme.major, ...FONTS].filter(Boolean) as string[])];
  const sizeOptions = fmt && !SIZES.includes(fmt.size) ? [...SIZES, fmt.size].sort((a, b) => a - b) : SIZES;
  const ready = Boolean(fmt);
  const paperMm = `${Math.round((section.width / 96) * 25.4)} × ${Math.round((section.height / 96) * 25.4)} mm`;

  return (
    <div className="flex flex-col h-[calc(100vh-var(--header-h))]">
      <style>{pkg.styles.css}</style>

      {/* Ribbon */}
      <div
        role="toolbar"
        aria-label="Formatting"
        className="mx-4 md:mx-6 mt-1 bg-white rounded-3xl shadow-subtle px-2 py-1.5 flex flex-wrap items-center gap-x-1 gap-y-1.5 z-30"
      >
        <select
          aria-label="Paragraph style"
          disabled={!ready}
          value={fmt?.style ?? ''}
          onChange={(e) => run(setParagraphAttrs({ style: e.target.value === pkg.styles.defaultParagraph ? null : e.target.value }))}
          className={`${selectCls} w-32`}
        >
          {styleOptions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Font"
          disabled={!ready}
          value={fmt?.font ?? ''}
          onChange={(e) => run(setMark(M.font, { family: e.target.value, xml: '' }))}
          className={`${selectCls} w-32`}
        >
          {fontOptions.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <select
          aria-label="Font size"
          disabled={!ready}
          value={fmt?.size ?? 11}
          onChange={(e) => run(setMark(M.size, { halfPts: Math.round(Number(e.target.value) * 2) }))}
          className={`${selectCls} w-[68px] tabular-nums`}
        >
          {sizeOptions.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <Divider />

        <ToolButton label="Bold (Ctrl+B)" on={fmt?.bold} disabled={!ready} onRun={() => toggleBold(!!fmt?.bold)}>
          <Bold className="w-4 h-4" />
        </ToolButton>
        <ToolButton label="Italic (Ctrl+I)" on={fmt?.italic} disabled={!ready} onRun={() => toggleItalic(!!fmt?.italic)}>
          <Italic className="w-4 h-4" />
        </ToolButton>
        <ToolButton label="Underline (Ctrl+U)" on={fmt?.underline} disabled={!ready} onRun={() => run(setMark(M.underline, fmt?.underline ? null : { val: 'single' }))}>
          <Underline className="w-4 h-4" />
        </ToolButton>
        <ToolButton label="Strikethrough" on={fmt?.strike} disabled={!ready} onRun={() => run(setMark(M.strike, fmt?.strike ? null : { double: false }))}>
          <Strikethrough className="w-4 h-4" />
        </ToolButton>
        <ToolButton label="Superscript" on={fmt?.sup} disabled={!ready} onRun={() => run(setMark(M.vertAlign, fmt?.sup ? null : { val: 'superscript' }))}>
          <Superscript className="w-4 h-4" />
        </ToolButton>
        <ToolButton label="Subscript" on={fmt?.sub} disabled={!ready} onRun={() => run(setMark(M.vertAlign, fmt?.sub ? null : { val: 'subscript' }))}>
          <Subscript className="w-4 h-4" />
        </ToolButton>
        <Popover label="Text colour" button={<Baseline className="w-4 h-4" />}>
          {(close) => (
            <div className="grid grid-cols-6 gap-1.5 w-max">
              {TEXT_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`#${c}`}
                  onClick={() => (run(setMark(M.color, { val: c, xml: '' })), close())}
                  className="w-5 h-5 rounded-full ring-1 ring-ink/15 hover:ring-ink/50"
                  style={{ backgroundColor: `#${c}` }}
                />
              ))}
              <button type="button" onClick={() => (run(setMark(M.color, null)), close())} className="col-span-6 text-caption text-graphite hover:text-ink mt-1">
                Automatic
              </button>
            </div>
          )}
        </Popover>
        <Popover label="Highlight" button={<Highlighter className="w-4 h-4" />}>
          {(close) => (
            <div className="grid grid-cols-4 gap-1.5 w-max">
              {HIGHLIGHTS.map((h) => (
                <button
                  key={h}
                  type="button"
                  aria-label={h}
                  onClick={() => (run(setMark(M.highlight, { val: h })), close())}
                  className="w-5 h-5 rounded-md ring-1 ring-ink/15 hover:ring-ink/50"
                  style={{ backgroundColor: HIGHLIGHT_CSS[h] }}
                />
              ))}
              <button type="button" onClick={() => (run(setMark(M.highlight, null)), close())} className="col-span-4 text-caption text-graphite hover:text-ink mt-1">
                No highlight
              </button>
            </div>
          )}
        </Popover>
        <ToolButton label="Clear formatting" disabled={!ready} onRun={clearFormatting}>
          <RemoveFormatting className="w-4 h-4" />
        </ToolButton>
        <Divider />

        {(
          [
            ['left', 'Align left (Ctrl+L)', TextAlignStart, null],
            ['center', 'Center (Ctrl+E)', TextAlignCenter, 'center'],
            ['right', 'Align right (Ctrl+R)', TextAlignEnd, 'right'],
            ['justify', 'Justify (Ctrl+J)', TextAlignJustify, 'justify'],
          ] as const
        ).map(([key, label, Icon, value]) => (
          <ToolButton key={key} label={label} on={fmt?.align === key} disabled={!ready} onRun={() => run(setParagraphAttrs({ align: value }))}>
            <Icon className="w-4 h-4" />
          </ToolButton>
        ))}
        <ToolButton label="Bullets" on={fmt?.list === 'app-bullet'} disabled={!ready} onRun={() => run(toggleListCommand('app-bullet', pkg))}>
          <List className="w-4 h-4" />
        </ToolButton>
        <ToolButton label="Numbering" on={fmt?.list === 'app-decimal'} disabled={!ready} onRun={() => run(toggleListCommand('app-decimal', pkg))}>
          <ListOrdered className="w-4 h-4" />
        </ToolButton>
        <ToolButton label="Decrease indent (Shift+Tab)" disabled={!ready} onRun={() => run(indentCommand(-1))}>
          <ListIndentDecrease className="w-4 h-4" />
        </ToolButton>
        <ToolButton label="Increase indent" disabled={!ready} onRun={() => run(indentCommand(1))}>
          <ListIndentIncrease className="w-4 h-4" />
        </ToolButton>
        <Divider />

        <Popover label="Insert table" button={<Table className="w-4 h-4" />}>
          {(close) => <TableGridPicker onPick={(r, c) => (run(insertTableCommand(r, c, contentWidth)), close())} />}
        </Popover>
        <ToolButton label="Insert picture" disabled={!ready} onRun={() => imageInput.current?.click()}>
          <ImageIcon className="w-4 h-4" />
        </ToolButton>
        <input
          ref={imageInput}
          type="file"
          accept="image/png,image/jpeg,image/gif"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file && activeRef.current) insertImageFile(activeRef.current, file);
            e.target.value = '';
          }}
        />
        <ToolButton label="Link" on={!!fmt?.link} disabled={!ready} onRun={editLink}>
          <Link className="w-4 h-4" />
        </ToolButton>
        <ToolButton label="Page break (Ctrl+Enter)" disabled={!ready} onRun={() => run(insertPageBreak)}>
          <SeparatorHorizontal className="w-4 h-4" />
        </ToolButton>

        {fmt?.inTable && (
          <div className="flex items-center gap-0.5 pl-1 ml-1 border-l border-ash" role="group" aria-label="Table">
            <ToolButton label="Insert row above" onRun={() => run(addRowBefore)}>
              <BetweenHorizontalStart className="w-4 h-4" />
            </ToolButton>
            <ToolButton label="Insert row below" onRun={() => run(addRowAfter)}>
              <BetweenHorizontalEnd className="w-4 h-4" />
            </ToolButton>
            <ToolButton label="Insert column left" onRun={() => run(addColumnBefore)}>
              <BetweenVerticalStart className="w-4 h-4" />
            </ToolButton>
            <ToolButton label="Insert column right" onRun={() => run(addColumnAfter)}>
              <BetweenVerticalEnd className="w-4 h-4" />
            </ToolButton>
            <ToolButton label="Merge cells" onRun={() => run(mergeCells)}>
              <TableCellsMerge className="w-4 h-4" />
            </ToolButton>
            <ToolButton label="Split cell" onRun={() => run(splitCell)}>
              <TableCellsSplit className="w-4 h-4" />
            </ToolButton>
            <Popover label="Delete" button={<Trash2 className="w-4 h-4" />}>
              {(close) => (
                <div className="flex flex-col text-caption w-36">
                  {(
                    [
                      ['Delete row', deleteRow],
                      ['Delete column', deleteColumn],
                      ['Delete table', deleteTable],
                    ] as const
                  ).map(([label, cmd]) => (
                    <button key={label} type="button" onClick={() => (run(cmd), close())} className="text-left px-2.5 py-1.5 rounded-lg text-graphite hover:bg-linen hover:text-ink">
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </Popover>
          </div>
        )}

        <div className="ml-auto flex items-center gap-1">
          <button type="button" onClick={handlePrint} className="btn btn-ghost h-[32px] px-3 text-caption" title="Print or save as PDF">
            <Printer className="w-3.5 h-3.5" />
            <span className="hidden 2xl:inline">Print / PDF</span>
          </button>
          <button type="button" onClick={handleDownload} disabled={!ready} className="btn btn-primary h-[32px] px-4 text-caption">
            <Download className="w-3.5 h-3.5" />
            <span>Download .docx</span>
          </button>
        </div>
      </div>

      <div className="min-w-0 flex-1 flex min-h-0">
        {outlineOpen && (
          <nav aria-label="Document outline" className="hidden lg:block w-60 shrink-0 overflow-y-auto pl-6 pr-2 py-6">
            <div className="eyebrow mb-2">Navigation</div>
            {outline.length ? (
              <ul className="space-y-0.5 text-caption">
                {outline.map((h) => (
                  <li key={h.pos}>
                    <button
                      type="button"
                      onClick={() => {
                        if (!bodyView) return;
                        const tr = bodyView.state.tr.setSelection(TextSelection.near(bodyView.state.doc.resolve(h.pos + 1)));
                        bodyView.dispatch(tr.scrollIntoView());
                        bodyView.focus();
                        (bodyView.nodeDOM(h.pos) as HTMLElement | null)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
                      }}
                      className="w-full text-left truncate py-1 pr-2 rounded-lg text-graphite hover:text-ink hover:bg-white/70"
                      style={{ paddingLeft: 8 + h.level * 12 }}
                      title={h.text}
                    >
                      {h.text}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-caption text-stone leading-relaxed">Headings you add appear here.</p>
            )}
          </nav>
        )}

        <div ref={canvasRef} className="min-w-0 flex-1 overflow-auto px-4 py-8" onMouseDown={(e) => e.target === e.currentTarget && bodyView?.focus()}>
          {!hasBody ? (
            <div className="text-center text-body-sm text-graphite py-24">Waiting for the document content from your collaborators…</div>
          ) : (
            <div
              className="wd-sheet"
              style={{
                width: section.width,
                minHeight: section.height,
                paddingLeft: section.left,
                paddingRight: section.right,
                zoom: zoom / 100,
              }}
            >
              <div style={{ paddingTop: section.header, minHeight: section.top, display: 'flex', flexDirection: 'column' }}>
                <div ref={headerRef} className="wd-hf" data-label="Header" hidden={!hfParts.header && !pkg.headerPart} />
              </div>
              <div ref={bodyRef} className="wd-body" />
              <div style={{ paddingBottom: section.footer, minHeight: section.bottom, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
                <div ref={footerRef} className="wd-hf" data-label="Footer" hidden={!hfParts.footer && !pkg.footerPart} />
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="h-8 px-4 md:px-6 flex items-center gap-3 md:gap-4 min-w-0 overflow-hidden whitespace-nowrap text-caption text-graphite border-t border-ash/60 bg-white/50">
        <span className="tabular-nums shrink-0">{stats.words.toLocaleString()} words</span>
        <span className="tabular-nums hidden md:inline">{stats.chars.toLocaleString()} characters</span>
        <span className="hidden lg:inline">{paperMm}</span>
        <button type="button" onClick={() => setOutlineOpen((o) => !o)} aria-pressed={outlineOpen} className={`hidden lg:inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 ${outlineOpen ? 'text-ink bg-cloud' : 'hover:text-ink'}`}>
          <ListTree className="w-3.5 h-3.5" />
          Navigation
        </button>
        {pkg.source === 'doc' && <span className="chip bg-marigold hidden md:inline-flex">Converted from .doc · saves as .docx</span>}
        <span className="ml-auto min-w-0 truncate hidden sm:inline">{fileName}</span>
        <div className="ml-auto sm:ml-0 flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => setFitTick((t) => t + 1)}
            aria-pressed={!customZoom.current}
            className={`rounded-md px-1.5 py-0.5 ${!customZoom.current ? 'text-ink bg-cloud' : 'hover:text-ink'}`}
            title="Fit page width to the window"
          >
            Fit
          </button>
          <button type="button" onClick={() => setManualZoom(Math.max(10, zoom - 10))} className="w-6 h-6 rounded-md flex items-center justify-center hover:text-ink hover:bg-cloud" aria-label="Zoom out">
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <input type="range" min={10} max={200} step={10} value={zoom} onChange={(e) => setManualZoom(Number(e.target.value))} aria-label="Zoom" className="w-24 accent-ink hidden sm:block" />
          <button type="button" onClick={() => setManualZoom(Math.min(200, zoom + 10))} className="w-6 h-6 rounded-md flex items-center justify-center hover:text-ink hover:bg-cloud" aria-label="Zoom in">
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
          <span className="tabular-nums w-9 text-right">{zoom}%</span>
        </div>
      </div>
    </div>
  );
};
