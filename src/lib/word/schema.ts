import { Schema, NodeSpec, MarkSpec, DOMOutputSpec } from 'prosemirror-model';
import { twipsToPx } from './xml';

/**
 * ProseMirror schema that mirrors WordprocessingML instead of HTML: paragraphs
 * carry Word paragraph properties (style id, numbering, indents in twips),
 * runs carry Word run properties as marks, and anything the editor does not
 * model is kept verbatim (`*X` attrs, raw_inline, raw_block) so it survives export.
 */

const ALIGN_CSS: Record<string, string> = { left: 'left', center: 'center', right: 'right', justify: 'justify' };

export function paragraphCss(a: Record<string, any>): string {
  const s: string[] = [];
  if (a.align && ALIGN_CSS[a.align]) s.push(`text-align:${ALIGN_CSS[a.align]}`);
  if (a.indL != null) s.push(`padding-left:${twipsToPx(a.indL)}px`);
  if (a.indR != null) s.push(`padding-right:${twipsToPx(a.indR)}px`);
  if (a.indFirst != null) s.push(`text-indent:${twipsToPx(a.indFirst)}px`);
  if (a.spBefore != null) s.push(`padding-top:${a.spBefore / 20}pt`);
  if (a.spAfter != null) s.push(`padding-bottom:${a.spAfter / 20}pt`);
  if (a.line != null) s.push(lineHeightCss(a.line, a.lineRule));
  return s.join(';');
}

/** Word "auto" line spacing is a multiple of 240; exact/atLeast are twips. */
export function lineHeightCss(line: number, rule: string | null): string {
  if (!rule || rule === 'auto') return `line-height:${((line / 240) * 1.15).toFixed(3)}`;
  return `line-height:${line / 20}pt`;
}

const paragraph: NodeSpec = {
  group: 'block',
  content: 'inline*',
  attrs: {
    style: { default: null },
    align: { default: null },
    indL: { default: null },
    indR: { default: null },
    indFirst: { default: null },
    spBefore: { default: null },
    spAfter: { default: null },
    line: { default: null },
    lineRule: { default: null },
    numId: { default: null },
    ilvl: { default: 0 },
    /** JSON string[] of pPr children the editor does not model */
    pPrX: { default: '' },
    /** Raw paragraph-mark rPr */
    markRpr: { default: '' },
  },
  parseDOM: [
    { tag: 'p', getAttrs: (el) => domParagraphAttrs(el as HTMLElement) },
    ...[1, 2, 3, 4, 5, 6].map((n) => ({
      tag: `h${n}`,
      getAttrs: (el: HTMLElement) => ({ ...domParagraphAttrs(el), style: `Heading${n}` }),
    })),
    { tag: 'li', getAttrs: (el) => domParagraphAttrs(el as HTMLElement) },
    { tag: 'blockquote', getAttrs: (el) => ({ ...domParagraphAttrs(el as HTMLElement), style: 'Quote' }) },
  ],
  toDOM: (node): DOMOutputSpec => {
    const a = node.attrs;
    const attrs: Record<string, string> = { class: 'wd-p' };
    if (a.style) attrs['data-style'] = a.style;
    const css = paragraphCss(a);
    if (css) attrs.style = css;
    return ['p', attrs, 0];
  },
};

function domParagraphAttrs(el: HTMLElement) {
  const align = el.style?.textAlign;
  const out: Record<string, any> = {};
  if (align && ALIGN_CSS[align]) out.align = align;
  const word = el.getAttribute('data-style');
  if (word) out.style = word;
  return out;
}

const table: NodeSpec = {
  group: 'block',
  content: 'table_row+',
  tableRole: 'table',
  isolating: true,
  attrs: {
    style: { default: null },
    bordered: { default: true },
    /** Raw w:tblPr (kept whole) */
    tblPrX: { default: '' },
  },
  parseDOM: [{ tag: 'table' }],
  toDOM: (node) => [
    'table',
    { class: `wd-table${node.attrs.bordered ? ' wd-bordered' : ''}`, 'data-style': node.attrs.style || undefined },
    ['tbody', 0],
  ],
};

const table_row: NodeSpec = {
  content: 'table_cell*',
  tableRole: 'row',
  attrs: { trPrX: { default: '' } },
  parseDOM: [{ tag: 'tr' }],
  toDOM: () => ['tr', 0],
};

const table_cell: NodeSpec = {
  content: 'block+',
  tableRole: 'cell',
  isolating: true,
  attrs: {
    colspan: { default: 1 },
    rowspan: { default: 1 },
    colwidth: { default: null },
    shade: { default: null },
    vAlign: { default: null },
    tcPrX: { default: '' },
  },
  parseDOM: [
    {
      tag: 'td, th',
      getAttrs: (el) => {
        const d = el as HTMLElement;
        const widthAttr = d.getAttribute('data-colwidth');
        const widths = widthAttr && /^\d+(,\d+)*$/.test(widthAttr) ? widthAttr.split(',').map(Number) : null;
        return {
          colspan: Number(d.getAttribute('colspan') || 1),
          rowspan: Number(d.getAttribute('rowspan') || 1),
          colwidth: widths,
        };
      },
    },
  ],
  toDOM: (node) => {
    const a = node.attrs;
    const attrs: Record<string, any> = {};
    if (a.colspan !== 1) attrs.colspan = a.colspan;
    if (a.rowspan !== 1) attrs.rowspan = a.rowspan;
    if (a.colwidth) attrs['data-colwidth'] = a.colwidth.join(',');
    const css: string[] = [];
    if (a.shade) css.push(`background-color:#${a.shade}`);
    if (a.vAlign) css.push(`vertical-align:${a.vAlign === 'center' ? 'middle' : a.vAlign}`);
    if (css.length) attrs.style = css.join(';');
    return ['td', attrs, 0];
  },
};

const image: NodeSpec = {
  inline: true,
  group: 'inline',
  atom: true,
  draggable: true,
  attrs: {
    /** Relationship id of a picture already in the package */
    rId: { default: null },
    /** data: URL of a picture added in the editor */
    src: { default: null },
    width: { default: 100 },
    height: { default: 100 },
    alt: { default: '' },
    /** Original w:drawing, re-emitted (with new extents) on export */
    xml: { default: '' },
  },
  parseDOM: [
    {
      tag: 'img[src]',
      getAttrs: (el) => {
        const img = el as HTMLImageElement;
        const src = img.getAttribute('src') || '';
        if (!src.startsWith('data:image/')) return false; // offline editor: only embedded pictures
        return {
          src,
          width: Number(img.getAttribute('width')) || img.naturalWidth || 200,
          height: Number(img.getAttribute('height')) || img.naturalHeight || 150,
          alt: img.getAttribute('alt') || '',
        };
      },
    },
  ],
  toDOM: (node) => ['img', { src: node.attrs.src || '', width: node.attrs.width, height: node.attrs.height, alt: node.attrs.alt }],
};

const hard_break: NodeSpec = {
  inline: true,
  group: 'inline',
  selectable: false,
  attrs: { type: { default: null } }, // null = line break, 'page', 'column'
  leafText: () => '\n',
  parseDOM: [{ tag: 'br' }],
  toDOM: (node) =>
    node.attrs.type === 'page' || node.attrs.type === 'column'
      ? ['span', { class: 'wd-pagebreak', 'data-type': node.attrs.type, contenteditable: 'false' }]
      : ['br'],
};

const tab: NodeSpec = {
  inline: true,
  group: 'inline',
  leafText: () => '\t',
  parseDOM: [{ tag: 'span.wd-tab' }],
  toDOM: () => ['span', { class: 'wd-tab' }, '\u0009'],
};

/** Run- or paragraph-level OOXML the editor shows but does not edit. */
const raw_inline: NodeSpec = {
  inline: true,
  group: 'inline',
  atom: true,
  attrs: {
    xml: { default: '' },
    /** 'run' = child of w:r (wrapped in a run on export), 'para' = child of w:p */
    level: { default: 'run' },
    label: { default: '' },
    /** Picture to preview (VML, OLE previews) */
    rId: { default: null },
  },
  toDOM: (node) => [
    'span',
    { class: node.attrs.label ? 'wd-raw' : 'wd-raw wd-raw-hidden', title: node.attrs.label || undefined },
    node.attrs.label || '',
  ],
};

const raw_block: NodeSpec = {
  group: 'block',
  atom: true,
  attrs: { xml: { default: '' }, label: { default: '' } },
  toDOM: (node) => ['div', { class: 'wd-raw-block', contenteditable: 'false' }, node.attrs.label || 'Unsupported content'],
};

const marks: Record<string, MarkSpec> = {
  link: {
    attrs: { href: { default: null }, rId: { default: null }, anchor: { default: null } },
    inclusive: false,
    parseDOM: [
      {
        tag: 'a[href]',
        getAttrs: (el) => {
          const href = (el as HTMLElement).getAttribute('href') || '';
          return href.startsWith('#') ? { anchor: href.slice(1) } : { href };
        },
      },
    ],
    toDOM: (m) => ['a', { href: m.attrs.href || (m.attrs.anchor ? `#${m.attrs.anchor}` : undefined), class: 'wd-link' }, 0],
  },
  rstyle: {
    attrs: { id: {} },
    toDOM: (m) => ['span', { 'data-rstyle': m.attrs.id }, 0],
  },
  bold: {
    attrs: { on: { default: true } },
    parseDOM: [
      { tag: 'strong' },
      { tag: 'b', getAttrs: (el) => (el as HTMLElement).style.fontWeight !== 'normal' && null },
      { style: 'font-weight', getAttrs: (v) => /^(bold(er)?|[6-9]\d\d)$/.test(v as string) && null },
    ],
    toDOM: (m) => ['span', { style: `font-weight:${m.attrs.on ? 700 : 400}` }, 0],
  },
  italic: {
    attrs: { on: { default: true } },
    parseDOM: [{ tag: 'i' }, { tag: 'em' }, { style: 'font-style=italic' }],
    toDOM: (m) => ['span', { style: `font-style:${m.attrs.on ? 'italic' : 'normal'}` }, 0],
  },
  underline: {
    attrs: { val: { default: 'single' }, color: { default: null } },
    parseDOM: [{ tag: 'u' }, { style: 'text-decoration-line=underline' }, { style: 'text-decoration=underline' }],
    toDOM: (m) =>
      m.attrs.val === 'none'
        ? ['span', { style: 'text-decoration:none' }, 0]
        : ['u', { style: m.attrs.val === 'double' ? 'text-decoration-style:double' : undefined }, 0],
  },
  strike: {
    attrs: { double: { default: false } },
    parseDOM: [{ tag: 's' }, { tag: 'del' }, { tag: 'strike' }, { style: 'text-decoration=line-through' }],
    toDOM: (m) => ['s', { style: m.attrs.double ? 'text-decoration-style:double' : undefined }, 0],
  },
  vertAlign: {
    attrs: { val: {} }, // 'superscript' | 'subscript'
    parseDOM: [
      { tag: 'sup', attrs: { val: 'superscript' } },
      { tag: 'sub', attrs: { val: 'subscript' } },
    ],
    toDOM: (m) => [m.attrs.val === 'subscript' ? 'sub' : 'sup', 0],
  },
  font: {
    attrs: { family: {}, xml: { default: '' } },
    parseDOM: [
      {
        style: 'font-family',
        getAttrs: (v) => {
          const family = (v as string).split(',')[0].trim().replace(/^["']|["']$/g, '');
          return family ? { family } : false;
        },
      },
    ],
    toDOM: (m) => ['span', { style: `font-family:${cssFontStack(m.attrs.family)}` }, 0],
  },
  size: {
    attrs: { halfPts: {} },
    parseDOM: [
      {
        style: 'font-size',
        getAttrs: (v) => {
          const m = /^([\d.]+)(pt|px)$/.exec(v as string);
          if (!m) return false;
          const pt = m[2] === 'pt' ? Number(m[1]) : Number(m[1]) * 0.75;
          return { halfPts: Math.round(pt * 2) };
        },
      },
    ],
    toDOM: (m) => ['span', { style: `font-size:${m.attrs.halfPts / 2}pt` }, 0],
  },
  color: {
    attrs: { val: {}, xml: { default: '' } },
    parseDOM: [
      {
        style: 'color',
        getAttrs: (v) => {
          const hex = cssColorToHex(v as string);
          return hex ? { val: hex } : false;
        },
      },
    ],
    toDOM: (m) => ['span', { style: m.attrs.val === 'auto' ? '' : `color:#${m.attrs.val}` }, 0],
  },
  highlight: {
    attrs: { val: {} },
    parseDOM: [{ tag: 'mark', attrs: { val: 'yellow' } }],
    toDOM: (m) => ['span', { style: `background-color:${HIGHLIGHT_CSS[m.attrs.val] ?? 'transparent'}` }, 0],
  },
  shade: {
    attrs: { fill: {} },
    toDOM: (m) => ['span', { style: `background-color:#${m.attrs.fill}` }, 0],
  },
  /** JSON string[] of rPr children the editor does not model (caps, lang, kern, ...) */
  rprx: {
    attrs: { xml: {} },
    toDOM: (m) => ['span', { style: rprxCss(m.attrs.xml) }, 0],
  },
};

/** Word's highlight palette (ST_HighlightColor). */
export const HIGHLIGHT_CSS: Record<string, string> = {
  yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff', blue: '#0000ff', red: '#ff0000',
  darkBlue: '#000080', darkCyan: '#008080', darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000',
  darkYellow: '#808000', darkGray: '#808080', lightGray: '#c0c0c0', black: '#000000', white: '#ffffff', none: 'transparent',
};

/** The few unmodelled run properties that change how text looks. */
function rprxCss(json: string): string {
  let list: string[] = [];
  try {
    list = JSON.parse(json);
  } catch {
    return '';
  }
  const css: string[] = [];
  for (const x of list) {
    const off = /w:val="(0|false|off)"/.test(x);
    if (/^<w:caps\b/.test(x) && !off) css.push('text-transform:uppercase');
    if (/^<w:smallCaps\b/.test(x) && !off) css.push('font-variant:small-caps');
    if (/^<w:vanish\b/.test(x) && !off) css.push('opacity:.45;text-decoration:underline dotted');
    const sp = /^<w:spacing\b[^>]*w:val="(-?\d+)"/.exec(x);
    if (sp) css.push(`letter-spacing:${Number(sp[1]) / 20}pt`);
  }
  return css.join(';');
}

function cssColorToHex(v: string): string | null {
  const hex = /^#([0-9a-f]{6})$/i.exec(v.trim());
  if (hex) return hex[1].toUpperCase();
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(v.trim());
  if (rgb) return rgb.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join('').toUpperCase();
  return null;
}

/** Metric-compatible open fonts for the Office core fonts, then a generic family. */
const FONT_FALLBACKS: Record<string, string> = {
  calibri: 'Carlito',
  cambria: 'Caladea',
  arial: 'Arimo, "Liberation Sans", Helvetica',
  'times new roman': 'Tinos, "Liberation Serif", Times',
  'courier new': 'Cousine, "Liberation Mono", Courier',
  aptos: '"Segoe UI", Carlito',
  helvetica: 'Arial',
};
const SERIF = /times|georgia|cambria|garamond|book|serif|minion|palatino|baskerville|caslon|century/i;
const MONO = /courier|mono|consol|code/i;

export function cssFontStack(family: string): string {
  const generic = MONO.test(family) ? 'monospace' : SERIF.test(family) ? 'serif' : 'sans-serif';
  const fb = FONT_FALLBACKS[family.toLowerCase()];
  return `"${family.replace(/"/g, '')}"${fb ? `, ${fb}` : ''}, ${generic}`;
}

export const wordSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph,
    table,
    table_row,
    table_cell,
    raw_block,
    text: { group: 'inline' },
    image,
    hard_break,
    tab,
    raw_inline,
  },
  marks,
});

export type WordNodeJSON = { type: string; attrs?: Record<string, any>; content?: WordNodeJSON[]; text?: string; marks?: { type: string; attrs?: Record<string, any> }[] };

