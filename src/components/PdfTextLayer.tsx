import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PDFDocument } from 'pdf-lib';
import { Page, pdfjs } from 'react-pdf';
import { interpretPage } from '../lib/pdf/contentStream';
import {
  Segment,
  TextEdit,
  PageGeometry,
  segmentsOf,
  pageGeometry,
  styleOf,
  editForSegment,
  insertionLike,
  nearestSegment,
  applyTextEdits,
  TextStyle,
} from '../lib/pdf/textEdit';

/**
 * Click-to-edit for the PDF's own text. The page shows the PDF with every
 * committed edit applied (rebuilt off-screen and swapped in when rendered, so
 * there is no flicker); the layer on top turns each line run into an editable
 * field that uses the run's own font, size and colour.
 */

type PDFProxy = Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>;

export interface PageTextModel {
  segments: Segment[];
  geometry: PageGeometry;
}

/** Text runs of the ORIGINAL file; edits always refer to these. */
export function usePdfTextModel(bytes: Uint8Array | null): PageTextModel[] | null {
  const [model, setModel] = useState<PageTextModel[] | null>(null);
  useEffect(() => {
    setModel(null);
    if (!bytes) return;
    let cancelled = false;
    (async () => {
      const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const pages = doc.getPages().map((page, i) => {
        const geometry = pageGeometry(page);
        try {
          return { segments: segmentsOf(interpretPage(doc, page), i), geometry };
        } catch (err) {
          console.warn(`Page ${i + 1}: text could not be read for editing`, err);
          return { segments: [], geometry };
        }
      });
      if (!cancelled) setModel(pages);
    })().catch((err) => console.warn('PDF text model failed:', err));
    return () => {
      cancelled = true;
    };
  }, [bytes]);
  return model;
}

const editKey = (e: TextEdit) => `${e.id}|${e.text}|${e.x0}|${e.baseline}`;

interface Slot {
  id: number;
  pdf: PDFProxy;
  keys: Set<string>;
  rendered: Set<number>;
}

/** The PDF as displayed: original bytes with every text edit applied, double-buffered. */
export function useEditedPdf(bytes: Uint8Array | null, edits: TextEdit[], numPages: number) {
  const [slots, setSlots] = useState<{ shown: Slot | null; next: Slot | null }>({ shown: null, next: null });
  const seq = useRef(0);
  const shownBytes = useRef<Uint8Array | null>(null);
  const key = edits.map(editKey).join('\n');

  useEffect(() => {
    if (!bytes) return;
    let cancelled = false;
    const fresh = shownBytes.current !== bytes;
    const timer = setTimeout(async () => {
      let out = bytes;
      if (edits.length) {
        try {
          out = await applyTextEdits(bytes, edits);
        } catch (err) {
          console.warn('Could not apply text edits; showing previews instead', err);
        }
      }
      const pdf = await pdfjs.getDocument({ data: out.slice() }).promise;
      if (cancelled) return void pdf.destroy();
      const slot: Slot = { id: ++seq.current, pdf, keys: new Set(out === bytes ? [] : edits.map(editKey)), rendered: new Set() };
      setSlots((s) => {
        if (fresh || !s.shown) {
          retire(s.shown, s.next);
          shownBytes.current = bytes;
          return { shown: slot, next: null };
        }
        retire(s.next);
        return { shown: s.shown, next: slot };
      });
    }, fresh ? 0 : 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `key` captures every edit field that changes the output
  }, [bytes, key]);

  useEffect(() => () => setSlots((s) => (retire(s.shown, s.next), { shown: null, next: null })), []);

  const onRendered = (slotId: number, pageIndex: number) =>
    setSlots((s) => {
      if (!s.next || s.next.id !== slotId) return s;
      s.next.rendered.add(pageIndex);
      if (s.next.rendered.size < numPages) return s;
      retire(s.shown);
      return { shown: s.next, next: null };
    });

  return { ...slots, onRendered };
}

/** Destroy a document once the pages showing it have unmounted. */
function retire(...slots: (Slot | null)[]) {
  for (const s of slots) if (s) setTimeout(() => s.pdf.destroy(), 1500);
}

/** One page: the displayed version, plus the next one rendering invisibly underneath. */
export const EditedPage: React.FC<{
  pageIndex: number;
  shown: Slot | null;
  next: Slot | null;
  onRendered: (slotId: number, pageIndex: number) => void;
  onLoadSuccess?: (page: { originalWidth: number }) => void;
}> = ({ pageIndex, shown, next, onRendered, onLoadSuccess }) => (
  <>
    {shown ? (
      <Page key={shown.id} pdf={shown.pdf as any} pageNumber={pageIndex + 1} renderTextLayer={false} renderAnnotationLayer={false} className="pointer-events-none" onLoadSuccess={onLoadSuccess} />
    ) : (
      <Page pageNumber={pageIndex + 1} renderTextLayer={false} renderAnnotationLayer={false} className="pointer-events-none" onLoadSuccess={onLoadSuccess} />
    )}
    {next && (
      <div className="absolute inset-0 invisible pointer-events-none" aria-hidden>
        <Page
          key={next.id}
          pdf={next.pdf as any}
          pageNumber={pageIndex + 1}
          renderTextLayer={false}
          renderAnnotationLayer={false}
          onRenderSuccess={() => onRendered(next.id, pageIndex)}
          onRenderError={() => onRendered(next.id, pageIndex)}
        />
      </div>
    )}
  </>
);

// ================= Editing layer =================

let measureCtx: CanvasRenderingContext2D | null = null;
const cssFont = (s: TextStyle) => `${s.italic ? 'italic ' : ''}${s.bold ? 700 : 400} ${s.size}px ${s.family}`;
function textWidth(text: string, s: TextStyle): number {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  if (!measureCtx) return text.length * s.size * 0.5;
  measureCtx.font = cssFont(s);
  return measureCtx.measureText(text).width + Math.max(0, text.length - 1) * s.letterSpacing;
}

/** Most common colour around a box on the page canvas: the paper behind the text. */
function paperColor(host: HTMLElement | null, box: { l: number; t: number; w: number; h: number }): string {
  // The page canvas is a sibling of the layer; skip the copy rendering invisibly underneath
  const canvas = ([...(host?.parentElement?.querySelectorAll('.react-pdf__Page canvas') ?? [])] as HTMLCanvasElement[]).find((c) => !c.closest('.invisible')) ?? null;
  const ctx = canvas?.getContext('2d', { willReadFrequently: true } as CanvasRenderingContext2DSettings);
  if (!canvas || !ctx) return '#ffffff';
  const sx = canvas.width / 100;
  const sy = canvas.height / 100;
  const counts = new Map<string, { n: number; r: number; g: number; b: number }>();
  const sample = (px: number, py: number) => {
    const x = Math.round(px * sx);
    const y = Math.round(py * sy);
    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
    const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
    const k = `${r >> 3},${g >> 3},${b >> 3}`;
    const c = counts.get(k) ?? { n: 0, r: 0, g: 0, b: 0 };
    counts.set(k, { n: c.n + 1, r: c.r + r, g: c.g + g, b: c.b + b });
  };
  for (let i = 0; i <= 12; i++) {
    const x = box.l + (box.w * i) / 12;
    sample(x, box.t - 0.3);
    sample(x, box.t + box.h + 0.3);
  }
  sample(box.l - 0.5, box.t + box.h / 2);
  sample(box.l + box.w + 0.5, box.t + box.h / 2);
  const top = [...counts.values()].sort((a, b) => b.n - a.n)[0];
  if (!top) return '#ffffff';
  return `rgb(${Math.round(top.r / top.n)}, ${Math.round(top.g / top.n)}, ${Math.round(top.b / top.n)})`;
}

interface OpenEditor {
  editId: string | null;
  segment: Segment | null;
  base: Omit<TextEdit, 'id'>;
  style: TextStyle;
  value: string;
  box: { l: number; t: number; w: number; h: number };
  paper: string;
}

const sameRun = (e: TextEdit, s: Segment) =>
  e.original !== '' && e.pageIndex === s.pageIndex && Math.abs(e.x0 - s.x0) < 0.5 && Math.abs(e.baseline - s.baseline) < 0.5;

export const TextEditLayer: React.FC<{
  pageIndex: number;
  model: PageTextModel | undefined;
  edits: TextEdit[];
  /** Edits already visible in the rendered page (others are previewed) */
  shownKeys: Set<string>;
  mode: 'edit' | 'insert' | 'off';
  onUpsert: (e: Omit<TextEdit, 'id'> & { id?: string }) => void;
  onRemove: (id: string) => void;
}> = ({ pageIndex, model, edits, shownKeys, mode, onUpsert, onRemove }) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<OpenEditor | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editor) inputRef.current?.focus();
  }, [editor?.base.x0, editor?.base.baseline, editor?.editId]);
  useEffect(() => {
    if (mode === 'off') setEditor(null);
  }, [mode]);

  const g = model?.geometry;
  const editable = g && g.rotation === 0;

  const boxFor = (x0: number, x1: number, baseline: number, size: number) => {
    const [l, t] = g!.toView(x0, baseline + 0.88 * size);
    const [r, b] = g!.toView(x1, baseline - 0.26 * size);
    return { l, t, w: Math.max(r - l, 0.5), h: b - t };
  };
  const pct = (px: number) => (px / g!.viewWidth) * 100;

  const items = useMemo(() => {
    if (!model || !editable) return [];
    const runs = model.segments.map((s) => {
      const edit = edits.find((e) => sameRun(e, s)) ?? null;
      const style = styleOf(s.glyphs[0]);
      const text = edit ? edit.text : s.text;
      const box = boxFor(s.x0, Math.max(s.x1, s.x0 + textWidth(text, style)), s.baseline, s.size);
      return { kind: 'run' as const, segment: s, edit, style, text, box };
    });
    const inserts = edits
      .filter((e) => e.original === '')
      .map((e) => {
        const like = nearestSegment(model.segments, e.styleX, e.styleY);
        const style = like ? styleOf(like.glyphs[0]) : { family: 'Helvetica, Arial, sans-serif', bold: false, italic: false, color: '#000000', size: e.size, letterSpacing: 0 };
        return { kind: 'insert' as const, segment: like, edit: e, style, text: e.text, box: boxFor(e.originX, e.originX + textWidth(e.text, style), e.baseline, e.size) };
      });
    return [...runs, ...inserts];
  }, [model, edits, editable]);

  if (!model || !editable || mode === 'off') {
    // Still show edits that have not reached the rendered page yet
    return null;
  }

  const open = (item: (typeof items)[number]) => {
    if (!item.segment && item.kind === 'run') return;
    const base =
      item.kind === 'run'
        ? editForSegment(item.segment!, item.text)
        : { ...item.edit!, id: undefined };
    const original = item.kind === 'run' ? boxFor(item.segment!.x0, item.segment!.x1, item.segment!.baseline, item.segment!.size) : item.box;
    setEditor({
      editId: item.edit?.id ?? null,
      segment: item.kind === 'run' ? item.segment : null,
      base: base as Omit<TextEdit, 'id'>,
      style: item.style,
      value: item.text,
      box: item.box,
      paper: paperColor(hostRef.current, original),
    });
  };

  const commit = (cancel = false) => {
    const ed = editor;
    setEditor(null);
    if (!ed || cancel) return;
    const value = ed.value;
    if (ed.segment) {
      // Edit of an existing run: back to the original text = no edit
      if (value === ed.segment.text) {
        if (ed.editId) onRemove(ed.editId);
        return;
      }
      onUpsert({ ...editForSegment(ed.segment, value), id: ed.editId ?? undefined });
    } else {
      if (!value.trim()) {
        if (ed.editId) onRemove(ed.editId);
        return;
      }
      onUpsert({ ...ed.base, text: value, id: ed.editId ?? undefined });
    }
  };

  const insertAt = (e: React.PointerEvent<HTMLDivElement>) => {
    if (mode !== 'insert' || e.target !== e.currentTarget) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const [x, y] = g!.toUser(((e.clientX - rect.left) / rect.width) * 100, ((e.clientY - rect.top) / rect.height) * 100);
    const like = nearestSegment(model.segments, x, y);
    if (!like) return; // no text to take typography from: the classic text box handles it
    e.stopPropagation();
    e.preventDefault();
    const baseline = y - like.size * 0.35;
    const style = styleOf(like.glyphs[0]);
    const box = boxFor(x, x + like.size * 4, baseline, like.size);
    setEditor({
      editId: null,
      segment: null,
      base: insertionLike(like, pageIndex, x, baseline, ''),
      style,
      value: '',
      box,
      paper: 'transparent',
    });
  };

  const previews = items.filter((it) => it.edit && !shownKeys.has(editKey(it.edit)));

  return (
    <div
      ref={hostRef}
      className={`absolute inset-0 z-10 ${mode === 'insert' ? 'cursor-text' : ''}`}
      style={{ pointerEvents: mode === 'insert' ? 'auto' : 'none' }}
      onPointerDown={insertAt}
    >
      {/* Edits not yet in the rendered page: cover the old glyphs and show the new text */}
      {previews.map((it) =>
        editor && it.edit?.id === editor.editId ? null : (
          <div
            key={`p-${it.edit!.id}`}
            className="absolute whitespace-pre pointer-events-none"
            style={{
              left: `${it.box.l}%`,
              top: `${it.box.t}%`,
              height: `${it.box.h}%`,
              minWidth: it.kind === 'run' ? `${boxFor(it.segment!.x0, it.segment!.x1, it.segment!.baseline, it.segment!.size).w}%` : undefined,
              background: it.kind === 'run' ? paperColor(hostRef.current, it.box) : 'transparent',
              font: cssFont(it.style),
              color: it.style.color,
              letterSpacing: it.style.letterSpacing,
              lineHeight: 1.14,
            }}
          >
            {it.text}
          </div>
        )
      )}

      {items.map((it, i) =>
        editor && ((it.edit && it.edit.id === editor.editId) || (it.segment && it.segment === editor.segment)) ? null : (
          <div
            key={it.edit?.id ?? it.segment?.key ?? i}
            role="button"
            tabIndex={-1}
            aria-label={`Edit text: ${it.text}`}
            title={it.segment && !it.segment.editable ? 'This text uses a font that cannot be edited in place' : undefined}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => it.segment?.editable !== false && open(it)}
            className={`pdf-text-run absolute rounded-[2px] ${
              it.segment?.editable === false ? 'cursor-not-allowed' : 'cursor-text hover:outline hover:outline-1 hover:outline-azure/70 hover:bg-azure/[0.06]'
            } ${it.edit ? 'outline outline-1 outline-dashed outline-azure/35' : ''}`}
            style={{ left: `${it.box.l}%`, top: `${it.box.t}%`, width: `${it.box.w}%`, height: `${it.box.h}%`, pointerEvents: 'auto' }}
          />
        )
      )}

      {editor && (
        <input
          ref={inputRef}
          value={editor.value}
          spellCheck
          onChange={(e) => setEditor({ ...editor, value: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') commit(true);
            e.stopPropagation();
          }}
          onBlur={() => commit()}
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute z-20 p-0 m-0 border-0 outline outline-2 outline-azure rounded-[2px]"
          style={{
            left: `${editor.box.l}%`,
            top: `${editor.box.t}%`,
            height: `${editor.box.h}%`,
            width: `max(${editor.box.w}%, ${pct(textWidth(editor.value, editor.style) + editor.style.size)}%)`,
            font: cssFont(editor.style),
            color: editor.style.color,
            letterSpacing: editor.style.letterSpacing,
            background: editor.paper,
            caretColor: editor.style.color,
            pointerEvents: 'auto',
          }}
        />
      )}
    </div>
  );
};

export { editKey };
