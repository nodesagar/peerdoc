import { kids, child, descendant, wAttr, rAttr, num, onOff, outerXml, rootNamespaces, parseXml, twipsToPx, emuToPx } from './xml';
import { WordPackage } from './package';
import { fontFromRFonts } from './styles';
import { WordNodeJSON } from './schema';

/**
 * WordprocessingML part -> ProseMirror JSON. Deterministic (no random ids,
 * no clocks): every peer importing the same bytes produces the same document,
 * which the CRDT seed relies on.
 */

type MarkJSON = { type: string; attrs?: Record<string, any> };

interface Ctx {
  pkg: WordPackage;
  part: string;
  ns: Map<string, string>;
}

const BODY_INVISIBLE = new Set([
  'bookmarkStart', 'bookmarkEnd', 'permStart', 'permEnd', 'commentRangeStart', 'commentRangeEnd',
  'moveFromRangeStart', 'moveFromRangeEnd', 'moveToRangeStart', 'moveToRangeEnd', 'customXmlInsRangeStart',
  'customXmlInsRangeEnd', 'customXmlDelRangeStart', 'customXmlDelRangeEnd',
]);

/** Root of an editable part: w:body for the main document, w:hdr / w:ftr otherwise. */
function partRoot(pkg: WordPackage, part: string): Element {
  const root = parseXml(pkg.text(part) || '').documentElement;
  return part === pkg.main ? (child(root, 'body') ?? root) : root;
}

export function importPart(pkg: WordPackage, part: string): WordNodeJSON {
  const xmlRoot = parseXml(pkg.text(part) || '').documentElement;
  const ctx: Ctx = { pkg, part, ns: rootNamespaces(xmlRoot) };
  const container = partRoot(pkg, part);
  const content = blocks(ctx, kids(container), part === pkg.main);
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

function blocks(ctx: Ctx, els: Element[], isBody = false): WordNodeJSON[] {
  const out: WordNodeJSON[] = [];
  let pending: WordNodeJSON[] = []; // body-level markers, folded into the next paragraph
  let lastParagraph: WordNodeJSON | null = null;

  const visit = (list: Element[]) => {
    list.forEach((el, i) => {
      const name = el.localName;
      if (name === 'p') {
        const p = paragraph(ctx, el);
        if (pending.length) p.content = [...pending, ...(p.content ?? [])];
        pending = [];
        out.push(p);
        lastParagraph = p;
      } else if (name === 'tbl') {
        out.push(table(ctx, el));
      } else if (name === 'sdt') {
        visit(kids(child(el, 'sdtContent')));
      } else if (name === 'customXml') {
        visit(kids(el).filter((k) => k.localName !== 'customXmlPr'));
      } else if (name === 'sectPr' && isBody && i === list.length - 1) {
        // final section properties stay in the package; export puts them back
      } else if (BODY_INVISIBLE.has(name) || name === 'proofErr') {
        if (name !== 'proofErr') pending.push(rawInline(ctx, el, 'para', '', []));
      } else {
        out.push({ type: 'raw_block', attrs: { xml: outerXml(el, ctx.ns), label: rawBlockLabel(el) } });
      }
    });
  };
  visit(els);

  if (pending.length) {
    const target = lastParagraph as WordNodeJSON | null;
    if (target) target.content = [...(target.content ?? []), ...pending];
    else out.push({ type: 'paragraph', content: pending });
  }
  return out;
}

function rawBlockLabel(el: Element): string {
  if (el.localName === 'altChunk') return 'Embedded content (kept as is)';
  const text = (el.textContent || '').trim().slice(0, 120);
  return text ? `${text}` : `Word content: ${el.localName} (kept as is)`;
}

// ================= Paragraphs =================

const PPR_KNOWN = new Set(['pStyle', 'jc', 'ind', 'spacing', 'numPr', 'rPr']);
const SPACING_ATTRS = new Set(['w:before', 'w:after', 'w:line', 'w:lineRule']);
const IND_ATTRS = new Set(['w:left', 'w:start', 'w:right', 'w:end', 'w:firstLine', 'w:hanging']);

/** True when an element has attributes beyond those the editor models. */
const hasExtraAttrs = (el: Element, known: Set<string>) => Array.from(el.attributes).some((a) => !known.has(a.name));

export function paragraphAttrs(ctx: Ctx, pPr: Element | null): Record<string, any> {
  const attrs: Record<string, any> = {};
  if (!pPr) return attrs;
  const extras: string[] = [];
  for (const el of kids(pPr)) {
    switch (el.localName) {
      case 'pStyle':
        attrs.style = wAttr(el, 'val');
        break;
      case 'jc': {
        const v = wAttr(el, 'val');
        const map: Record<string, string> = { left: 'left', start: 'left', center: 'center', right: 'right', end: 'right', both: 'justify', distribute: 'justify' };
        if (v && map[v]) attrs.align = map[v];
        else extras.push(outerXml(el, ctx.ns));
        break;
      }
      case 'ind': {
        const left = num(wAttr(el, 'left') ?? wAttr(el, 'start'));
        const right = num(wAttr(el, 'right') ?? wAttr(el, 'end'));
        const hanging = num(wAttr(el, 'hanging'));
        const first = num(wAttr(el, 'firstLine'));
        if (left !== null) attrs.indL = left;
        if (right !== null) attrs.indR = right;
        if (hanging !== null) attrs.indFirst = -hanging;
        else if (first !== null) attrs.indFirst = first;
        if (hasExtraAttrs(el, IND_ATTRS)) extras.push(outerXml(el, ctx.ns));
        break;
      }
      case 'spacing': {
        const before = num(wAttr(el, 'before'));
        const after = num(wAttr(el, 'after'));
        const line = num(wAttr(el, 'line'));
        if (before !== null) attrs.spBefore = before;
        if (after !== null) attrs.spAfter = after;
        if (line !== null) {
          attrs.line = line;
          attrs.lineRule = wAttr(el, 'lineRule');
        }
        if (hasExtraAttrs(el, SPACING_ATTRS)) extras.push(outerXml(el, ctx.ns));
        break;
      }
      case 'numPr': {
        const numId = wAttr(child(el, 'numId'), 'val');
        if (numId !== null) attrs.numId = numId;
        attrs.ilvl = num(wAttr(child(el, 'ilvl'), 'val')) ?? 0;
        break;
      }
      case 'rPr':
        attrs.markRpr = outerXml(el, ctx.ns);
        break;
      default:
        extras.push(outerXml(el, ctx.ns));
    }
  }
  if (extras.length) attrs.pPrX = JSON.stringify(extras);
  return attrs;
}

function paragraph(ctx: Ctx, p: Element): WordNodeJSON {
  const attrs = paragraphAttrs(ctx, child(p, 'pPr'));
  const content: WordNodeJSON[] = [];
  inlines(ctx, kids(p).filter((k) => k.localName !== 'pPr'), [], content);
  const node: WordNodeJSON = { type: 'paragraph' };
  if (Object.keys(attrs).length) node.attrs = attrs;
  if (content.length) node.content = content;
  return node;
}

function inlines(ctx: Ctx, els: Element[], marks: MarkJSON[], out: WordNodeJSON[]) {
  for (const el of els) {
    switch (el.localName) {
      case 'r':
        run(ctx, el, marks, out);
        break;
      case 'hyperlink': {
        const rId = rAttr(el, 'id');
        const rel = rId ? ctx.pkg.rels(ctx.part).get(rId) : undefined;
        const anchor = wAttr(el, 'anchor');
        const link: MarkJSON = { type: 'link', attrs: { href: rel?.target ?? null, rId: rId ?? null, anchor: anchor ?? null } };
        inlines(ctx, kids(el), [...marks, link], out);
        break;
      }
      case 'ins':
      case 'moveTo':
      case 'dir':
      case 'bdo':
        inlines(ctx, kids(el), marks, out);
        break;
      case 'smartTag':
      case 'customXml':
        inlines(ctx, kids(el).filter((k) => !k.localName.endsWith('Pr')), marks, out);
        break;
      case 'sdt':
        inlines(ctx, kids(child(el, 'sdtContent')), marks, out);
        break;
      case 'fldSimple':
        out.push(rawInline(ctx, el, 'para', (el.textContent || '').trim() || 'Field', marks));
        break;
      case 'oMath':
      case 'oMathPara':
        out.push(rawInline(ctx, el, 'para', (el.textContent || 'Equation').trim(), marks));
        break;
      case 'proofErr':
        break; // spelling/grammar marker; Word regenerates it
      default:
        // bookmarks, comment ranges, deleted text, permissions: invisible, kept
        out.push(rawInline(ctx, el, 'para', '', marks));
    }
  }
}

function rawInline(ctx: Ctx, el: Element, level: 'run' | 'para', label: string, marks: MarkJSON[], rId: string | null = null): WordNodeJSON {
  const node: WordNodeJSON = { type: 'raw_inline', attrs: { xml: outerXml(el, ctx.ns), level, label, rId } };
  if (marks.length) node.marks = marks;
  return node;
}

function run(ctx: Ctx, r: Element, outer: MarkJSON[], out: WordNodeJSON[]) {
  const marks = [...outer, ...runMarks(ctx, child(r, 'rPr'))];
  const withMarks = (n: WordNodeJSON): WordNodeJSON => (marks.length ? { ...n, marks } : n);
  const text = (s: string) => s && out.push(withMarks({ type: 'text', text: s }));

  for (const el of kids(r)) {
    switch (el.localName) {
      case 'rPr':
      case 'lastRenderedPageBreak':
        break;
      case 't':
        text(el.textContent || '');
        break;
      case 'tab':
      case 'ptab':
        out.push(withMarks({ type: 'tab' }));
        break;
      case 'br': {
        const type = wAttr(el, 'type');
        out.push(withMarks({ type: 'hard_break', attrs: { type: type === 'page' || type === 'column' ? type : null } }));
        break;
      }
      case 'cr':
        out.push(withMarks({ type: 'hard_break' }));
        break;
      case 'noBreakHyphen':
        text('‑');
        break;
      case 'softHyphen':
        text('­');
        break;
      case 'drawing': {
        const img = drawingImage(ctx, el, marks);
        out.push(img ?? rawInline(ctx, el, 'run', drawingLabel(el), marks));
        break;
      }
      case 'pict':
      case 'object': {
        const rId = rAttr(descendant(el, 'imagedata'), 'id');
        out.push(rawInline(ctx, el, 'run', el.localName === 'object' ? 'Embedded object' : 'Picture', marks, rId));
        break;
      }
      case 'AlternateContent':
        out.push(rawInline(ctx, el, 'run', drawingLabel(el), marks));
        break;
      case 'sym': {
        const code = parseInt(wAttr(el, 'char') || '', 16);
        out.push(rawInline(ctx, el, 'run', Number.isFinite(code) ? String.fromCharCode(code >= 0xf000 ? code - 0xf000 : code) : '?', marks));
        break;
      }
      case 'footnoteReference':
      case 'endnoteReference':
        out.push(rawInline(ctx, el, 'run', `[${wAttr(el, 'id') ?? '*'}]`, marks));
        break;
      default:
        // fldChar / instrText / comment references etc.: invisible, kept in place
        out.push(rawInline(ctx, el, 'run', '', marks));
    }
  }
}

function drawingLabel(el: Element): string {
  if (descendant(el, 'chart')) return 'Chart';
  const box = descendant(el, 'txbxContent');
  if (box) return `Text box: ${(box.textContent || '').trim().slice(0, 60)}`;
  return 'Shape';
}

function drawingImage(ctx: Ctx, drawing: Element, marks: MarkJSON[]): WordNodeJSON | null {
  const blip = descendant(drawing, 'blip');
  const rId = rAttr(blip, 'embed');
  if (!rId) return null;
  const extent = descendant(drawing, 'extent');
  const docPr = descendant(drawing, 'docPr');
  const node: WordNodeJSON = {
    type: 'image',
    attrs: {
      rId,
      src: null,
      width: Math.round(emuToPx(num(extent?.getAttribute('cx')) ?? 952500)),
      height: Math.round(emuToPx(num(extent?.getAttribute('cy')) ?? 952500)),
      alt: docPr?.getAttribute('descr') || docPr?.getAttribute('title') || '',
      xml: outerXml(drawing, ctx.ns),
    },
  };
  if (marks.length) node.marks = marks;
  return node;
}

// ================= Run properties =================

export function runMarks(ctx: Ctx, rPr: Element | null): MarkJSON[] {
  if (!rPr) return [];
  const marks: MarkJSON[] = [];
  const extras: string[] = [];
  for (const el of kids(rPr)) {
    const v = wAttr(el, 'val');
    switch (el.localName) {
      case 'rStyle':
        if (v) marks.push({ type: 'rstyle', attrs: { id: v } });
        break;
      case 'rFonts': {
        const family = fontFromRFonts(el, ctx.pkg.theme);
        if (family) marks.push({ type: 'font', attrs: { family, xml: outerXml(el, ctx.ns) } });
        else extras.push(outerXml(el, ctx.ns));
        break;
      }
      case 'b':
        marks.push({ type: 'bold', attrs: { on: onOff(el) } });
        break;
      case 'i':
        marks.push({ type: 'italic', attrs: { on: onOff(el) } });
        break;
      case 'u':
        marks.push({ type: 'underline', attrs: { val: v || 'single', color: wAttr(el, 'color') } });
        break;
      case 'strike':
        if (onOff(el)) marks.push({ type: 'strike', attrs: { double: false } });
        break;
      case 'dstrike':
        if (onOff(el)) marks.push({ type: 'strike', attrs: { double: true } });
        break;
      case 'vertAlign':
        if (v === 'superscript' || v === 'subscript') marks.push({ type: 'vertAlign', attrs: { val: v } });
        break;
      case 'sz': {
        const n = num(v);
        if (n) marks.push({ type: 'size', attrs: { halfPts: n } });
        break;
      }
      case 'color':
        if (v) marks.push({ type: 'color', attrs: { val: v, xml: outerXml(el, ctx.ns) } });
        break;
      case 'highlight':
        if (v && v !== 'none') marks.push({ type: 'highlight', attrs: { val: v } });
        break;
      case 'shd': {
        const fill = wAttr(el, 'fill');
        if (fill && /^[0-9A-Fa-f]{6}$/.test(fill) && (wAttr(el, 'val') ?? 'clear') === 'clear') {
          marks.push({ type: 'shade', attrs: { fill } });
        } else extras.push(outerXml(el, ctx.ns));
        break;
      }
      default:
        extras.push(outerXml(el, ctx.ns));
    }
  }
  if (extras.length) marks.push({ type: 'rprx', attrs: { xml: JSON.stringify(extras) } });
  return marks;
}

// ================= Tables =================

function table(ctx: Ctx, tbl: Element): WordNodeJSON {
  const tblPr = child(tbl, 'tblPr');
  const style = wAttr(child(tblPr, 'tblStyle'), 'val');
  const borders = child(tblPr, 'tblBorders');
  const bordered = Boolean(borders && kids(borders).some((b) => !['nil', 'none'].includes(wAttr(b, 'val') || '')));
  const grid = kids(child(tbl, 'tblGrid'))
    .filter((g) => g.localName === 'gridCol')
    .map((g) => num(wAttr(g, 'w')) ?? 0);

  const rowEls: Element[] = [];
  const collectRows = (els: Element[]) => {
    for (const el of els) {
      if (el.localName === 'tr') rowEls.push(el);
      else if (el.localName === 'sdt') collectRows(kids(child(el, 'sdtContent')));
      else if (el.localName === 'customXml') collectRows(kids(el));
    }
  };
  collectRows(kids(tbl));

  // Word expresses vertical merges as restart/continue cells; ProseMirror uses rowspan
  const active = new Map<number, WordNodeJSON>();
  const rows: WordNodeJSON[] = [];
  for (const tr of rowEls) {
    const trPr = child(tr, 'trPr');
    const tblPrEx = child(tr, 'tblPrEx');
    let col = num(wAttr(child(trPr, 'gridBefore'), 'val')) ?? 0;
    const cells: WordNodeJSON[] = [];
    const cellEls: Element[] = [];
    const collectCells = (els: Element[]) => {
      for (const el of els) {
        if (el.localName === 'tc') cellEls.push(el);
        else if (el.localName === 'sdt') collectCells(kids(child(el, 'sdtContent')));
        else if (el.localName === 'customXml') collectCells(kids(el));
      }
    };
    collectCells(kids(tr));

    for (const tc of cellEls) {
      const tcPr = child(tc, 'tcPr');
      const span = num(wAttr(child(tcPr, 'gridSpan'), 'val')) ?? 1;
      const vMergeEl = child(tcPr, 'vMerge');
      const vMerge = vMergeEl ? (wAttr(vMergeEl, 'val') ?? 'continue') : null;
      const origin = active.get(col);
      if (vMerge === 'continue' && origin && (origin.attrs!.colspan ?? 1) === span) {
        origin.attrs!.rowspan += 1;
        col += span;
        continue;
      }
      const attrs: Record<string, any> = { colspan: span, rowspan: 1 };
      const widths = grid.slice(col, col + span);
      if (widths.length === span && widths.every((w) => w > 0)) attrs.colwidth = widths.map((w) => Math.round(twipsToPx(w)));
      const extras: string[] = [];
      for (const el of kids(tcPr)) {
        if (el.localName === 'gridSpan' || el.localName === 'vMerge' || el.localName === 'tcW') continue;
        if (el.localName === 'shd' && /^[0-9A-Fa-f]{6}$/.test(wAttr(el, 'fill') || '')) attrs.shade = wAttr(el, 'fill');
        else if (el.localName === 'vAlign') attrs.vAlign = wAttr(el, 'val');
        else extras.push(outerXml(el, ctx.ns));
      }
      if (extras.length) attrs.tcPrX = JSON.stringify(extras);
      const content = blocks(ctx, kids(tc).filter((k) => k.localName !== 'tcPr'));
      const cell: WordNodeJSON = { type: 'table_cell', attrs, content: content.length ? content : [{ type: 'paragraph' }] };
      cells.push(cell);
      for (let c = col; c < col + span; c++) active.delete(c);
      if (vMerge === 'restart') active.set(col, cell);
      col += span;
    }
    const rowAttrs: Record<string, any> = {};
    const rowX = [tblPrEx, trPr].filter(Boolean).map((el) => outerXml(el!, ctx.ns));
    if (rowX.length) rowAttrs.trPrX = JSON.stringify(rowX);
    if (cells.length) rows.push({ type: 'table_row', attrs: rowAttrs, content: cells });
  }

  if (!rows.length) return { type: 'paragraph' };
  return {
    type: 'table',
    attrs: { style, bordered, tblPrX: tblPr ? outerXml(tblPr, ctx.ns) : '' },
    content: rows,
  };
}
