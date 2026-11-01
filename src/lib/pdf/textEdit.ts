import { PDFDocument, PDFPage, PDFName, StandardFonts, PDFFont } from 'pdf-lib';
import { Attribution } from '../../types';
import { interpretPage, Glyph, PageContent, Op, Matrix, fillToCss, hexBytes, fromLatin1, FontInfo } from './contentStream';

/**
 * In-place PDF text editing. An edit names a run of glyphs on a page (by their
 * position in PDF user space) and its replacement text. Applying it removes
 * those glyphs from the page's content stream, keeping their advance so the rest
 * of the line does not move, and draws the new text at the same origin with the
 * same font resource, size, spacing and colour. Characters the original
 * (usually subset) font has no glyph for fall back to the closest standard font.
 */

export interface TextEdit extends Attribution {
  id: string;
  pageIndex: number;
  /** Glyphs replaced (user space); x0 === x1 for inserted text */
  x0: number;
  x1: number;
  /** Baseline and font size of the run, user space */
  baseline: number;
  size: number;
  /** Where new text starts (user space) */
  originX: number;
  /** Point inside the glyph run whose typography the text uses */
  styleX: number;
  styleY: number;
  original: string;
  text: string;
}

export interface Segment {
  /** Stable id from the run's position */
  key: string;
  pageIndex: number;
  text: string;
  glyphs: Glyph[];
  x0: number;
  x1: number;
  baseline: number;
  size: number;
  editable: boolean;
}

const horizontal = (m: Matrix) => Math.abs(m[1]) < 1e-3 && Math.abs(m[2]) < 1e-3 && m[0] > 0 && m[3] > 0;

/** Group glyphs into line runs, the way readers select text. */
export function segmentsOf(pc: PageContent, pageIndex: number): Segment[] {
  const out: Segment[] = [];
  let cur: Segment | null = null;
  const close = () => {
    if (cur && cur.text.trim()) {
      cur.text = cur.text.replace(/\s+$/, '');
      out.push(cur);
    }
    cur = null;
  };
  for (const g of pc.glyphs) {
    const visible = g.state.render !== 3 && g.state.render !== 7;
    const ok = visible && horizontal(g.m) && !!g.state.font;
    if (cur) {
      const c: Segment = cur;
      const last = c.glyphs[c.glyphs.length - 1];
      const gap = g.x0 - c.x1;
      const sameLine = Math.abs(g.y - c.baseline) < 0.2 * c.size;
      const sameStyle = g.state.font === last.state.font && Math.abs(g.size - c.size) < 0.05 * c.size && g.state.fill.join() === last.state.fill.join();
      if (!ok || !sameLine || !sameStyle || gap < -0.5 * c.size || gap > 1.5 * c.size) close();
    }
    if (!ok) continue;
    const ch = g.unicode ?? '';
    if (!cur) {
      if (!ch.trim()) continue;
      cur = { key: `${pageIndex}:${g.x0.toFixed(1)}:${g.y.toFixed(1)}`, pageIndex, text: '', glyphs: [], x0: g.x0, x1: g.x1, baseline: g.y, size: g.size, editable: true };
    }
    const c: Segment = cur;
    const gap = g.x0 - c.x1;
    if (c.glyphs.length && gap > 0.2 * c.size && !/\s$/.test(c.text) && ch.trim()) c.text += ' ';
    c.text += ch || '�';
    if (g.unicode === null || !g.state.font!.editable) c.editable = false;
    c.glyphs.push(g);
    c.x1 = Math.max(c.x1, g.x1);
  }
  close();
  return out;
}

export interface TextStyle {
  family: string;
  bold: boolean;
  italic: boolean;
  color: string;
  size: number;
  letterSpacing: number;
}

const PS_NAMES: [RegExp, string][] = [
  [/^TimesNewRoman/i, 'Times New Roman'],
  [/^Arial/i, 'Arial'],
  [/^CourierNew/i, 'Courier New'],
  [/^Helvetica/i, 'Helvetica'],
  [/^Times/i, 'Times New Roman'],
  [/^Courier/i, 'Courier New'],
];

/** CSS approximation of a PDF font, for the inline editor only (the page shows real glyphs). */
export function cssFamily(font: FontInfo): string {
  const raw = font.baseName.replace(/^[A-Z]{6}\+/, '').split(/[-,]/)[0];
  const known = PS_NAMES.find(([re]) => re.test(raw))?.[1];
  const spaced = raw.replace(/(MT|PS|PSMT|Std)$/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
  const generic = font.mono ? 'monospace' : font.serif ? 'serif' : 'sans-serif';
  return [known, spaced, raw].filter(Boolean).map((f) => `"${f}"`).join(', ') + `, ${generic}`;
}

export function styleOf(g: Glyph): TextStyle {
  const font = g.state.font!;
  return {
    family: cssFamily(font),
    bold: font.bold,
    italic: font.italic,
    color: fillToCss(g.state.fill),
    size: g.size,
    letterSpacing: g.state.tc * (g.size / (g.state.size || 1)),
  };
}

/** Edit record for a segment (or an insertion styled like `like`). */
export function editForSegment(seg: Segment, text: string): Omit<TextEdit, 'id'> {
  const first = seg.glyphs[0];
  return {
    pageIndex: seg.pageIndex,
    x0: seg.x0,
    x1: seg.x1,
    baseline: seg.baseline,
    size: seg.size,
    originX: first.x0,
    styleX: (first.x0 + first.x1) / 2,
    styleY: first.y,
    original: seg.text,
    text,
  };
}

export function insertionLike(seg: Segment, pageIndex: number, x: number, baseline: number, text: string): Omit<TextEdit, 'id'> {
  const first = seg.glyphs[0];
  return { pageIndex, x0: x, x1: x, baseline, size: seg.size, originX: x, styleX: (first.x0 + first.x1) / 2, styleY: first.y, original: '', text };
}

/** Closest run to a point: same line first, then vertical distance. */
export function nearestSegment(segments: Segment[], x: number, y: number): Segment | null {
  let best: Segment | null = null;
  let bestScore = Infinity;
  for (const s of segments) {
    const dy = Math.abs(s.baseline - y);
    const dx = x < s.x0 ? s.x0 - x : x > s.x1 ? x - s.x1 : 0;
    const score = dy * 3 + dx;
    if (score < bestScore) (bestScore = score), (best = s);
  }
  return best;
}

// ================= Applying edits =================

const fmt = (n: number) => (Math.abs(n) < 1e-6 ? '0' : Number(n.toFixed(4)).toString());

function matchGlyphs(glyphs: Glyph[], e: TextEdit): Glyph[] {
  if (e.x1 <= e.x0) return [];
  const tol = 0.15 * e.size;
  return glyphs.filter((g) => {
    const mid = (g.x0 + g.x1) / 2;
    return mid >= e.x0 - tol && mid <= e.x1 + tol && Math.abs(g.y - e.baseline) < 0.35 * e.size && Math.abs(g.size - e.size) < 0.3 * e.size && horizontal(g.m);
  });
}

function styleGlyph(glyphs: Glyph[], e: TextEdit, matched: Glyph[]): Glyph | null {
  if (matched.length) return matched[0];
  let best: Glyph | null = null;
  let d = Infinity;
  for (const g of glyphs) {
    if (!g.state.font || !horizontal(g.m)) continue;
    const dist = Math.hypot((g.x0 + g.x1) / 2 - e.styleX, g.y - e.styleY);
    if (dist < d) (d = dist), (best = g);
  }
  return best;
}

const FALLBACKS: Record<string, StandardFonts> = {
  sans: StandardFonts.Helvetica,
  sansB: StandardFonts.HelveticaBold,
  sansI: StandardFonts.HelveticaOblique,
  sansBI: StandardFonts.HelveticaBoldOblique,
  serif: StandardFonts.TimesRoman,
  serifB: StandardFonts.TimesRomanBold,
  serifI: StandardFonts.TimesRomanItalic,
  serifBI: StandardFonts.TimesRomanBoldItalic,
  mono: StandardFonts.Courier,
  monoB: StandardFonts.CourierBold,
  monoI: StandardFonts.CourierOblique,
  monoBI: StandardFonts.CourierBoldOblique,
};

async function fallbackFont(doc: PDFDocument, page: PDFPage, font: FontInfo, cache: Map<string, { key: string; font: PDFFont }>) {
  const fam = font.mono ? 'mono' : font.serif ? 'serif' : 'sans';
  const id = `${fam}${font.bold ? 'B' : ''}${font.italic ? 'I' : ''}`;
  let hit = cache.get(id);
  if (!hit) {
    const pdfFont = await doc.embedFont(FALLBACKS[id]);
    const key = page.node.newFontDictionary(`EdF${id}`, pdfFont.ref).decodeText();
    hit = { key, font: pdfFont };
    cache.set(id, hit);
  }
  return hit;
}

/** TJ array drawing `text` with the original font, or null if a glyph is missing. Spaces may be synthesised. */
function encodeWithFont(font: FontInfo, text: string): string | null {
  if (!font.editable) return null;
  const parts: string[] = [];
  let bytes: number[] = [];
  for (const ch of Array.from(text)) {
    const code = font.codeFor(ch);
    if (code !== null) {
      bytes.push(...(font.twoByte ? [code >> 8, code & 0xff] : [code]));
      continue;
    }
    if (ch === ' ') {
      // Subset fonts often lack a space glyph: move by a quarter em instead
      if (bytes.length) parts.push(hexBytes(bytes));
      bytes = [];
      parts.push('-250');
      continue;
    }
    return null;
  }
  if (bytes.length) parts.push(hexBytes(bytes));
  return `[${parts.join(' ')}]`;
}

export async function applyTextEditsToDoc(doc: PDFDocument, edits: TextEdit[]): Promise<void> {
  const byPage = new Map<number, TextEdit[]>();
  for (const e of edits) byPage.set(e.pageIndex, [...(byPage.get(e.pageIndex) ?? []), e]);
  const pages = doc.getPages();

  for (const [pageIndex, pageEdits] of byPage) {
    const page = pages[pageIndex];
    if (!page) continue;
    const pc = interpretPage(doc, page);
    const removedByOp = new Map<number, Set<number>>();
    const draws: string[] = [];
    const fontCache = new Map<string, { key: string; font: PDFFont }>();

    for (const e of pageEdits) {
      const matched = matchGlyphs(pc.glyphs, e);
      for (const g of matched) {
        const set = removedByOp.get(g.opIndex) ?? new Set<number>();
        set.add(g.index);
        removedByOp.set(g.opIndex, set);
      }
      if (!e.text) continue;
      const style = styleGlyph(pc.glyphs, e, matched);
      if (!style?.state.font) continue;
      const st = style.state;
      const font = st.font!;
      // Text matrix in default user space: the style glyph's orientation and scale, at the edit's origin
      const m: Matrix = matched.length ? [...matched[0].m] : [...style.m];
      if (!matched.length) {
        m[4] = e.originX;
        m[5] = e.baseline;
      }
      let tj = encodeWithFont(font, e.text);
      let resName = font.resName;
      if (tj === null) {
        const fb = await fallbackFont(doc, page, font, fontCache);
        const supported = new Set(fb.font.getCharacterSet());
        const safe = Array.from(e.text).map((ch) => (supported.has(ch.codePointAt(0)!) ? ch : '?')).join('');
        tj = `[${fb.font.encodeText(safe).toString()}]`;
        resName = fb.key;
      }
      draws.push(
        [
          'BT',
          ...st.fill,
          `/${resName} ${fmt(st.size)} Tf`,
          `${fmt(st.tc)} Tc ${fmt(st.tw)} Tw ${fmt(st.tz)} Tz ${fmt(st.rise)} Ts ${st.render} Tr`,
          `${m.map(fmt).join(' ')} Tm`,
          `${tj} TJ`,
          'ET',
        ].join('\n')
      );
    }

    // Splice rewritten show operators into the original content (back to front)
    let content = pc.content;
    const opIndexes = [...removedByOp.keys()].sort((a, b) => b - a);
    for (const idx of opIndexes) {
      const op = pc.ops[idx];
      const twoByte = pc.glyphs.find((g) => g.opIndex === idx)?.state.font?.twoByte ?? false;
      const advances = new Map(pc.glyphs.filter((g) => g.opIndex === idx).map((g) => [g.index, g.adv1000]));
      const rewritten = rewriteWithAdvances(op, removedByOp.get(idx)!, twoByte, advances);
      content = content.slice(0, op.start) + rewritten + content.slice(op.end);
    }
    if (!draws.length && !opIndexes.length) continue;
    // Isolate the original content so its state cannot leak into the new text
    const final = draws.length ? `q\n${content}\nQ\nq\n${draws.join('\n')}\nQ\n` : content;
    const stream = doc.context.flateStream(fromLatin1(final));
    page.node.set(PDFName.of('Contents'), doc.context.register(stream));
  }
}

/** Rewrite one show operator without the removed glyphs, keeping every advance. */
function rewriteWithAdvances(op: Op, removed: Set<number>, twoByte: boolean, advances: Map<number, number>): string {
  const items: unknown[] = op.op === 'TJ' ? ((op.operands[op.operands.length - 1] as unknown[]) ?? []) : op.operands.slice(-1);
  const out: string[] = [];
  let bytes: number[] = [];
  let num = 0;
  let index = 0;
  const flushBytes = () => (bytes.length && out.push(hexBytes(bytes)), (bytes = []));
  const flushNum = () => (Math.abs(num) > 1e-6 && out.push(fmt(num)), (num = 0));
  for (const item of items) {
    if (typeof item === 'number') {
      flushBytes();
      num += item;
      continue;
    }
    if (!item || typeof item !== 'object' || !('bytes' in (item as object))) continue;
    const b = (item as { bytes: number[] }).bytes;
    const step = twoByte ? 2 : 1;
    for (let k = 0; k < b.length; k += step) {
      if (removed.has(index)) {
        // TJ numbers move left, so the removed glyph's advance is subtracted
        flushBytes();
        num -= advances.get(index) ?? 0;
      } else {
        flushNum();
        bytes.push(...b.slice(k, k + step));
      }
      index++;
    }
  }
  flushBytes();
  flushNum();
  const prefix = op.op === "'" ? 'T* ' : op.op === '"' ? `${fmt(op.operands[0] as number)} Tw ${fmt(op.operands[1] as number)} Tc T* ` : '';
  return `${prefix}[${out.join(' ')}] TJ`;
}

export async function applyTextEdits(bytes: Uint8Array, edits: TextEdit[]): Promise<Uint8Array> {
  if (!edits.length) return bytes;
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  await applyTextEditsToDoc(doc, edits);
  return doc.save();
}

// ================= Page geometry (user space <-> view percent) =================

export interface PageGeometry {
  rotation: number;
  /** user space -> percent of the displayed page */
  toView(x: number, y: number): [number, number];
  /** percent of the displayed page -> user space */
  toUser(px: number, py: number): [number, number];
  /** displayed page width in points (1 CSS px at scale 1) */
  viewWidth: number;
}

export function pageGeometry(page: PDFPage): PageGeometry {
  const box = page.getCropBox();
  const [x0, y0, w, h] = [box.x, box.y, box.width, box.height];
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  const toView = (x: number, y: number): [number, number] => {
    switch (rotation) {
      case 90:
        return [((y - y0) / h) * 100, ((x - x0) / w) * 100];
      case 180:
        return [((x0 + w - x) / w) * 100, ((y - y0) / h) * 100];
      case 270:
        return [((y0 + h - y) / h) * 100, ((x0 + w - x) / w) * 100];
      default:
        return [((x - x0) / w) * 100, ((y0 + h - y) / h) * 100];
    }
  };
  const toUser = (px: number, py: number): [number, number] => {
    const [u, v] = [px / 100, py / 100];
    switch (rotation) {
      case 90:
        return [x0 + v * w, y0 + u * h];
      case 180:
        return [x0 + w - u * w, y0 + v * h];
      case 270:
        return [x0 + w - v * w, y0 + h - u * h];
      default:
        return [x0 + u * w, y0 + h - v * h];
    }
  };
  return { rotation, toView, toUser, viewWidth: rotation % 180 ? h : w };
}
