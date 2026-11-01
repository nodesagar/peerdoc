import { PDFDocument, PDFPage, PDFDict, PDFName, PDFArray, PDFNumber, PDFStream, PDFRawStream, PDFRef, decodePDFRawStream } from 'pdf-lib';
import { Encodings, Font as StdFont, FontNames } from '@pdf-lib/standard-fonts';

/**
 * Minimal PDF content-stream interpreter for text: tokenises a page's content,
 * tracks the graphics/text state (CTM, text matrices, font, spacing, colour) and
 * yields every shown glyph with its exact position, advance and Unicode value.
 * Content is handled as a latin1 string so untouched bytes round-trip exactly.
 */

export type Matrix = [number, number, number, number, number, number];
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
export const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];

// ================= Tokens =================

type Operand = number | string | boolean | null | { name: string } | { bytes: number[]; hex: boolean } | Operand[] | { dict: true };

export interface Op {
  op: string;
  operands: Operand[];
  /** latin1 offsets in the content string: first operand .. end of operator */
  start: number;
  end: number;
}

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set('()<>[]{}/%'.split('').map((c) => c.charCodeAt(0)));

export function tokenize(src: string): Op[] {
  const ops: Op[] = [];
  let i = 0;
  const n = src.length;
  let operands: Operand[] = [];
  let opStart = -1;
  const stack: Operand[][] = [];

  const push = (v: Operand, at: number) => {
    if (opStart < 0 && !stack.length) opStart = at;
    if (stack.length) stack[stack.length - 1].push(v);
    else operands.push(v);
  };

  const readLiteral = (): number[] => {
    const bytes: number[] = [];
    let depth = 1;
    i++; // (
    while (i < n && depth > 0) {
      const c = src.charCodeAt(i);
      if (c === 0x5c) {
        const nx = src[i + 1];
        i += 2;
        if (nx === undefined) break;
        const map: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
        if (nx in map) bytes.push(map[nx]);
        else if (/[0-7]/.test(nx)) {
          let oct = nx;
          while (oct.length < 3 && /[0-7]/.test(src[i] ?? '')) oct += src[i++];
          bytes.push(parseInt(oct, 8) & 0xff);
        } else if (nx === '\r') {
          if (src[i] === '\n') i++;
        } else if (nx !== '\n') bytes.push(nx.charCodeAt(0));
        continue;
      }
      if (c === 0x28) depth++;
      else if (c === 0x29 && --depth === 0) {
        i++;
        break;
      }
      bytes.push(c & 0xff);
      i++;
    }
    return bytes;
  };

  while (i < n) {
    const c = src.charCodeAt(i);
    if (WS.has(c)) {
      i++;
      continue;
    }
    if (c === 0x25) {
      while (i < n && src[i] !== '\n' && src[i] !== '\r') i++;
      continue;
    }
    const at = i;
    if (c === 0x28) {
      push({ bytes: readLiteral(), hex: false }, at);
      continue;
    }
    if (c === 0x3c && src[i + 1] === '<') {
      // inline dictionary (marked-content properties): skip to the matching >>
      let depth = 0;
      while (i < n) {
        if (src[i] === '<' && src[i + 1] === '<') (depth++, (i += 2));
        else if (src[i] === '>' && src[i + 1] === '>') {
          i += 2;
          if (--depth === 0) break;
        } else if (src[i] === '(') readLiteral();
        else i++;
      }
      push({ dict: true }, at);
      continue;
    }
    if (c === 0x3c) {
      const close = src.indexOf('>', i);
      let hex = src.slice(i + 1, close < 0 ? n : close).replace(/[^0-9a-fA-F]/g, '');
      if (hex.length % 2) hex += '0';
      const bytes: number[] = [];
      for (let k = 0; k < hex.length; k += 2) bytes.push(parseInt(hex.slice(k, k + 2), 16));
      i = close < 0 ? n : close + 1;
      push({ bytes, hex: true }, at);
      continue;
    }
    if (c === 0x5b) {
      if (opStart < 0 && !stack.length) opStart = at;
      stack.push([]);
      i++;
      continue;
    }
    if (c === 0x5d) {
      const arr = stack.pop() ?? [];
      i++;
      if (stack.length) stack[stack.length - 1].push(arr);
      else operands.push(arr);
      continue;
    }
    if (c === 0x2f) {
      let j = i + 1;
      while (j < n && !WS.has(src.charCodeAt(j)) && !DELIM.has(src.charCodeAt(j))) j++;
      push({ name: src.slice(i + 1, j).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) }, at);
      i = j;
      continue;
    }
    let j = i;
    while (j < n && !WS.has(src.charCodeAt(j)) && !DELIM.has(src.charCodeAt(j))) j++;
    if (j === i) {
      i++; // stray delimiter (e.g. '>' or '{'): skip
      continue;
    }
    const word = src.slice(i, j);
    i = j;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) push(Number(word), at);
    else if (word === 'true' || word === 'false') push(word === 'true', at);
    else if (word === 'null') push(null, at);
    else if (stack.length) stack[stack.length - 1].push(word); // keyword inside array: tolerate
    else {
      if (word === 'BI') {
        // inline image: skip binary data up to whitespace + EI + whitespace
        const id = src.indexOf('ID', i);
        let k = id < 0 ? n : id + 3;
        const m = /\sEI(?=[\s]|$)/g;
        m.lastIndex = k;
        const hit = m.exec(src);
        k = hit ? hit.index + hit[0].length : n;
        ops.push({ op: 'BI', operands: [], start: opStart < 0 ? at : opStart, end: k });
        i = k;
      } else {
        ops.push({ op: word, operands, start: opStart < 0 ? at : opStart, end: j });
      }
      operands = [];
      opStart = -1;
    }
  }
  return ops;
}

// ================= Fonts =================

export interface FontInfo {
  resName: string;
  baseName: string;
  twoByte: boolean;
  /** Glyph advance in 1/1000 em */
  widthOf(code: number): number;
  unicodeOf(code: number): string | null;
  /** Code that draws this character with this font's own glyphs, if the font has it */
  codeFor(ch: string): number | null;
  bold: boolean;
  italic: boolean;
  serif: boolean;
  mono: boolean;
  /** Type3 or unsupported encoding: text can be read for display but not re-encoded */
  editable: boolean;
}

const nameOf = (v: unknown) => (v instanceof PDFName ? v.decodeText() : null);
const numOf = (v: unknown) => (v instanceof PDFNumber ? v.asNumber() : null);

function streamText(doc: PDFDocument, v: unknown): string | null {
  const s = v instanceof PDFRef ? doc.context.lookup(v) : v;
  if (s instanceof PDFRawStream) return latin1(decodePDFRawStream(s).decode());
  if (s instanceof PDFStream) return latin1(s.getContents());
  return null;
}

export const latin1 = (b: Uint8Array) => {
  let out = '';
  for (let i = 0; i < b.length; i += 8192) out += String.fromCharCode.apply(null, b.subarray(i, i + 8192) as unknown as number[]);
  return out;
};
export const fromLatin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

/** ToUnicode CMap: bfchar / bfrange -> code -> string */
export function parseToUnicode(cmap: string): { map: Map<number, string>; twoByte: boolean } {
  const map = new Map<number, string>();
  let twoByte = false;
  const utf16 = (hex: string) => {
    let s = '';
    for (let k = 0; k + 3 < hex.length + 1; k += 4) s += String.fromCharCode(parseInt(hex.slice(k, k + 4).padEnd(4, '0'), 16));
    return s;
  };
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
      if (m[1].length > 2) twoByte = true;
      map.set(parseInt(m[1], 16), utf16(m[2]));
    }
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      if (m[1].length > 2) twoByte = true;
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      if (hi - lo > 0xffff) continue;
      if (m[3].startsWith('[')) {
        [...m[3].matchAll(/<([0-9a-fA-F]*)>/g)].forEach((d, k) => map.set(lo + k, utf16(d[1])));
      } else {
        const base = m[3].slice(1, -1);
        const head = utf16(base);
        for (let code = lo; code <= hi; code++) {
          map.set(code, head.slice(0, -1) + String.fromCharCode(head.charCodeAt(head.length - 1) + (code - lo)));
        }
      }
    }
  }
  return { map, twoByte };
}

// WinAnsi tables from pdf-lib's standard fonts: code <-> unicode <-> glyph name
const WIN = (() => {
  const mappings = (Encodings.WinAnsi as unknown as { unicodeMappings: Record<number, [number, string]> }).unicodeMappings;
  const codeToUni = new Map<number, string>();
  const codeToName = new Map<number, string>();
  const nameToUni = new Map<string, string>();
  for (const [cp, [code, name]] of Object.entries(mappings)) {
    const ch = String.fromCodePoint(Number(cp));
    if (!codeToUni.has(code)) codeToUni.set(code, ch);
    codeToName.set(code, name);
    nameToUni.set(name, ch);
  }
  return { codeToUni, codeToName, nameToUni };
})();

const glyphNameToUnicode = (name: string): string | null => {
  const known = WIN.nameToUni.get(name);
  if (known) return known;
  const uni = /^uni([0-9A-Fa-f]{4,6})$/.exec(name) ?? /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  return uni ? String.fromCodePoint(parseInt(uni[1], 16)) : null;
};

const STD_WIDTHS = new Map<string, StdFont>();
function standardFontFor(base: string): StdFont | null {
  const clean = base.replace(/^[A-Z]{6}\+/, '').replace(/,/g, '-');
  const alias: Record<string, string> = { Arial: 'Helvetica', 'Arial-Bold': 'Helvetica-Bold', 'Arial-Italic': 'Helvetica-Oblique', 'Arial-BoldItalic': 'Helvetica-BoldOblique', TimesNewRoman: 'Times-Roman', 'TimesNewRoman-Bold': 'Times-Bold', CourierNew: 'Courier' };
  const name = (Object.values(FontNames) as string[]).find((f) => f === clean) ?? alias[clean];
  if (!name) return null;
  if (!STD_WIDTHS.has(name)) STD_WIDTHS.set(name, StdFont.load(name as FontNames));
  return STD_WIDTHS.get(name)!;
}

export function loadFont(doc: PDFDocument, resName: string, dict: PDFDict): FontInfo {
  const subtype = nameOf(dict.get(PDFName.of('Subtype'))) ?? '';
  const baseName = nameOf(dict.get(PDFName.of('BaseFont'))) ?? resName;
  const toUni = streamText(doc, dict.get(PDFName.of('ToUnicode')));
  const cmap = toUni ? parseToUnicode(toUni) : null;
  const lookupDict = (d: PDFDict, key: string) => d.lookupMaybe(PDFName.of(key), PDFDict);

  let descriptor: PDFDict | undefined;
  let widthOf: (code: number) => number;
  let twoByte = false;
  let editable = true;
  let decode: (code: number) => string | null;
  let validCode: (code: number) => boolean;

  if (subtype === 'Type0') {
    const desc = dict.lookupMaybe(PDFName.of('DescendantFonts'), PDFArray)?.lookupMaybe(0, PDFDict);
    descriptor = desc ? lookupDict(desc, 'FontDescriptor') : undefined;
    const encoding = nameOf(dict.get(PDFName.of('Encoding')));
    twoByte = true;
    editable = encoding === 'Identity-H';
    const dw = (desc && numOf(desc.lookup(PDFName.of('DW')))) ?? 1000;
    const widths = new Map<number, number>();
    const w = desc?.lookupMaybe(PDFName.of('W'), PDFArray);
    if (w) {
      const items = w.asArray().map((x) => doc.context.lookup(x));
      for (let k = 0; k < items.length; ) {
        const first = numOf(items[k]);
        const next = items[k + 1];
        if (first === null) break;
        if (next instanceof PDFArray) {
          next.asArray().forEach((v, j) => widths.set(first + j, numOf(doc.context.lookup(v)) ?? dw));
          k += 2;
        } else {
          const last = numOf(next) ?? first;
          const width = numOf(items[k + 2]) ?? dw;
          for (let c = first; c <= last && c - first < 65536; c++) widths.set(c, width);
          k += 3;
        }
      }
    }
    widthOf = (code) => widths.get(code) ?? dw;
    decode = (code) => cmap?.map.get(code) ?? null;
    // Subset fonts only carry the glyphs their ToUnicode lists
    validCode = (code) => Boolean(cmap?.map.has(code));
  } else {
    descriptor = lookupDict(dict, 'FontDescriptor');
    editable = subtype !== 'Type3';
    const first = numOf(dict.lookup(PDFName.of('FirstChar'))) ?? 0;
    const arr = dict.lookupMaybe(PDFName.of('Widths'), PDFArray);
    const missing = (descriptor && numOf(descriptor.lookup(PDFName.of('MissingWidth')))) ?? 0;
    const widths = arr?.asArray().map((v) => numOf(doc.context.lookup(v)) ?? 0);
    const std = widths ? null : standardFontFor(baseName);
    // Encoding: base WinAnsi (close to StandardEncoding for text) plus /Differences
    const names = new Map<number, string>();
    const enc = dict.lookup(PDFName.of('Encoding'));
    if (enc instanceof PDFDict) {
      const diffs = enc.lookupMaybe(PDFName.of('Differences'), PDFArray);
      let code = 0;
      for (const v of diffs?.asArray() ?? []) {
        const item = doc.context.lookup(v);
        if (item instanceof PDFNumber) code = item.asNumber();
        else if (item instanceof PDFName) names.set(code++, item.decodeText());
      }
    }
    const glyphName = (code: number) => names.get(code) ?? WIN.codeToName.get(code);
    widthOf = (code) => {
      if (widths) return widths[code - first] ?? missing;
      const gn = glyphName(code);
      return (gn && std?.getWidthOfGlyph(gn)) || 500;
    };
    decode = (code) => {
      const fromCmap = cmap?.map.get(code);
      if (fromCmap !== undefined) return fromCmap;
      const diff = names.get(code);
      if (diff) return glyphNameToUnicode(diff);
      return WIN.codeToUni.get(code) ?? (code >= 32 && code < 127 ? String.fromCharCode(code) : null);
    };
    const embedded = Boolean(descriptor && ['FontFile', 'FontFile2', 'FontFile3'].some((k) => descriptor!.get(PDFName.of(k))));
    validCode = (code) =>
      !embedded || (cmap ? cmap.map.has(code) : widths ? (widths[code - first] ?? 0) > 0 : true);
  }

  const flags = (descriptor && numOf(descriptor.lookup(PDFName.of('Flags')))) ?? 0;
  const lower = baseName.toLowerCase();
  const reverse = new Map<string, number>();
  const maxCode = twoByte ? 0 : 255;
  if (twoByte) for (const [code, s] of cmap?.map ?? []) !reverse.has(s) && reverse.set(s, code);
  else
    for (let code = 0; code <= maxCode; code++) {
      if (!validCode(code)) continue;
      const s = decode(code);
      if (s && !reverse.has(s)) reverse.set(s, code);
    }

  return {
    resName,
    baseName,
    twoByte,
    widthOf,
    unicodeOf: decode,
    codeFor: (ch) => (editable ? (reverse.get(ch) ?? null) : null),
    bold: /bold|black|heavy|semibold|demi/.test(lower) || Boolean(flags & (1 << 18)),
    italic: /italic|oblique/.test(lower) || Boolean(flags & (1 << 6)),
    serif: Boolean(flags & 2) || /times|georgia|garamond|cambria|serif|minion|palatino|book/.test(lower),
    mono: Boolean(flags & 1) || /courier|mono|consol/.test(lower),
    editable,
  };
}

// ================= Interpretation =================

export interface TextState {
  ctm: Matrix;
  fill: string[]; // raw colour operators (colour space + colour) to re-emit
  font: FontInfo | null;
  size: number;
  tc: number;
  tw: number;
  tz: number;
  tl: number;
  rise: number;
  render: number;
}

export interface Glyph {
  code: number;
  unicode: string | null;
  /** Text space -> user space at this glyph's origin (Tm x CTM), before font scaling */
  m: Matrix;
  /** Baseline start / end, user space */
  x0: number;
  x1: number;
  y: number;
  /** Font size in user space */
  size: number;
  /** Advance in TJ units (thousandths of text space), for layout-preserving removal */
  adv1000: number;
  opIndex: number;
  /** Index of this glyph among the op's shown codes */
  index: number;
  state: TextState;
}

export interface PageContent {
  page: PDFPage;
  content: string;
  ops: Op[];
  glyphs: Glyph[];
}

export function pageContentString(doc: PDFDocument, page: PDFPage): string {
  const contents = page.node.Contents();
  if (!contents) return '';
  const parts = contents instanceof PDFArray ? contents.asArray() : [contents];
  return parts.map((p) => streamText(doc, p) ?? '').join('\n');
}

export function interpretPage(doc: PDFDocument, page: PDFPage, content = pageContentString(doc, page)): PageContent {
  const ops = tokenize(content);
  const fontDict = page.node.Resources()?.lookupMaybe(PDFName.of('Font'), PDFDict);
  const fonts = new Map<string, FontInfo | null>();
  const fontFor = (name: string) => {
    if (!fonts.has(name)) {
      const d = fontDict?.lookupMaybe(PDFName.of(name), PDFDict);
      let info: FontInfo | null = null;
      try {
        info = d ? loadFont(doc, name, d) : null;
      } catch {
        info = null;
      }
      fonts.set(name, info);
    }
    return fonts.get(name)!;
  };

  let gs: TextState = { ctm: IDENTITY, fill: [], font: null, size: 0, tc: 0, tw: 0, tz: 100, tl: 0, rise: 0, render: 0 };
  const stack: TextState[] = [];
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  const glyphs: Glyph[] = [];
  const nums = (o: Operand[]) => o.filter((x): x is number => typeof x === 'number');

  const show = (items: Operand[], opIndex: number) => {
    const font = gs.font;
    if (!font || !gs.size) return;
    const th = gs.tz / 100;
    let index = 0;
    for (const item of items) {
      if (typeof item === 'number') {
        tm = mul([1, 0, 0, 1, (-item / 1000) * gs.size * th, 0], tm);
        continue;
      }
      if (!item || typeof item !== 'object' || !('bytes' in item)) continue;
      const b = item.bytes;
      for (let k = 0; k < b.length; ) {
        const code = font.twoByte ? (b[k] << 8) | (b[k + 1] ?? 0) : b[k];
        k += font.twoByte ? 2 : 1;
        const w0 = font.widthOf(code) / 1000;
        const wordSpace = !font.twoByte && code === 32 ? gs.tw : 0;
        const tx = (w0 * gs.size + gs.tc + wordSpace) * th;
        const m = mul(tm, gs.ctm);
        const trm = mul([gs.size * th, 0, 0, gs.size, 0, gs.rise], m);
        const after = mul([1, 0, 0, 1, tx, 0], tm);
        const trmEnd = mul([gs.size * th, 0, 0, gs.size, 0, gs.rise], mul(after, gs.ctm));
        glyphs.push({
          code,
          unicode: font.unicodeOf(code),
          m,
          x0: trm[4],
          x1: trmEnd[4],
          y: trm[5],
          size: Math.hypot(trm[2], trm[3]),
          adv1000: (tx / (gs.size * th)) * 1000,
          opIndex,
          index: index++,
          state: gs,
        });
        tm = after;
      }
    }
  };

  ops.forEach((op, idx) => {
    const o = op.operands;
    switch (op.op) {
      case 'q':
        stack.push(gs);
        break;
      case 'Q':
        gs = stack.pop() ?? gs;
        break;
      case 'cm': {
        const v = nums(o);
        if (v.length === 6) gs = { ...gs, ctm: mul(v as Matrix, gs.ctm) };
        break;
      }
      case 'BT':
        tm = tlm = IDENTITY;
        break;
      case 'Tf': {
        const name = o.find((x): x is { name: string } => typeof x === 'object' && x !== null && 'name' in x);
        gs = { ...gs, font: name ? fontFor(name.name) : null, size: nums(o)[0] ?? gs.size };
        break;
      }
      case 'Tc':
        gs = { ...gs, tc: nums(o)[0] ?? 0 };
        break;
      case 'Tw':
        gs = { ...gs, tw: nums(o)[0] ?? 0 };
        break;
      case 'Tz':
        gs = { ...gs, tz: nums(o)[0] ?? 100 };
        break;
      case 'TL':
        gs = { ...gs, tl: nums(o)[0] ?? 0 };
        break;
      case 'Ts':
        gs = { ...gs, rise: nums(o)[0] ?? 0 };
        break;
      case 'Tr':
        gs = { ...gs, render: nums(o)[0] ?? 0 };
        break;
      case 'Td':
      case 'TD': {
        const [tx = 0, ty = 0] = nums(o);
        if (op.op === 'TD') gs = { ...gs, tl: -ty };
        tm = tlm = mul([1, 0, 0, 1, tx, ty], tlm);
        break;
      }
      case 'Tm': {
        const v = nums(o);
        if (v.length === 6) tm = tlm = v as Matrix;
        break;
      }
      case 'T*':
        tm = tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm);
        break;
      case 'Tj':
        show(o.slice(-1), idx);
        break;
      case "'":
        tm = tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm);
        show(o.slice(-1), idx);
        break;
      case '"': {
        const [aw = 0, ac = 0] = nums(o);
        gs = { ...gs, tw: aw, tc: ac };
        tm = tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm);
        show(o.slice(-1), idx);
        break;
      }
      case 'TJ':
        show((o[o.length - 1] as Operand[]) ?? [], idx);
        break;
      case 'cs':
        gs = { ...gs, fill: [content.slice(op.start, op.end)] };
        break;
      case 'sc':
      case 'scn':
        gs = { ...gs, fill: [...gs.fill.filter((f) => / cs$/.test(f)), content.slice(op.start, op.end)] };
        break;
      case 'g':
      case 'rg':
      case 'k':
        gs = { ...gs, fill: [content.slice(op.start, op.end)] };
        break;
    }
  });

  return { page, content, ops, glyphs };
}

/** CSS colour of a captured fill (DeviceGray / RGB / CMYK; anything else reads as black). */
export function fillToCss(fill: string[]): string {
  const last = fill[fill.length - 1] ?? '';
  const v = (last.match(/-?[\d.]+/g) ?? []).map(Number);
  const hex = (r: number, g: number, b: number) =>
    '#' + [r, g, b].map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0')).join('');
  if (/ g$/.test(last) || (/ scn?$/.test(last) && v.length === 1)) return hex(v[0], v[0], v[0]);
  if (/ rg$/.test(last) || (/ scn?$/.test(last) && v.length === 3)) return hex(v[0], v[1], v[2]);
  if (/ k$/.test(last) || (/ scn?$/.test(last) && v.length === 4)) {
    const [c, m, y, k] = v;
    return hex((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k));
  }
  return '#000000';
}

export const hexBytes = (bytes: number[]) => '<' + bytes.map((b) => b.toString(16).padStart(2, '0')).join('') + '>';
