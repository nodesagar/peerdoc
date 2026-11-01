import * as CFB from 'cfb';
import { esc, xmlSafe } from './xml';

/**
 * Word 97-2003 binary (.doc) -> WordprocessingML body XML, entirely in the browser.
 * Reads the piece table (text), paragraph/character property pages (PAPX/CHPX),
 * the stylesheet (headings, title) and the font table. Covers text, paragraphs,
 * headings, alignment, indents, spacing, tables, bold/italic/underline/strike,
 * caps, size, colour, fonts, super/subscript, line and page breaks; field codes
 * are dropped and their results kept.
 * ponytail: no pictures, list numbering, headers/footers or nested tables from
 * .doc; add them by parsing the LST/LFO, PlcfHdd and drawing tables if needed.
 */

interface ParaProps {
  sti: number | null;
  jc?: number;
  left?: number;
  right?: number;
  first?: number;
  before?: number;
  after?: number;
  inTable?: boolean;
  rowEnd?: boolean;
}

interface CharProps {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  dstrike?: boolean;
  underline?: boolean;
  caps?: boolean;
  smallCaps?: boolean;
  vanish?: boolean;
  special?: boolean;
  size?: number;
  color?: string;
  vert?: number;
  font?: string;
}

const ICO = ['', '000000', '0000FF', '00FFFF', '00FF00', 'FF00FF', 'FF0000', 'FFFF00', 'FFFFFF', '000080', '008080', '008000', '800080', '800000', '808000', '808080', 'C0C0C0'];

function stream(cfb: CFB.CFB$Container, name: string): Uint8Array | null {
  const entry = CFB.find(cfb, name);
  if (!entry?.content) return null;
  const c = entry.content as unknown as ArrayLike<number>;
  return c instanceof Uint8Array ? c : Uint8Array.from(c);
}

/** Operand length of a sprm (MS-DOC 2.2.5.1) at `pos` (the opcode). */
function sprmLength(buf: DataView, pos: number, sprm: number): number {
  const spra = sprm >>> 13;
  if (spra === 0 || spra === 1) return 1;
  if (spra === 2 || spra === 4 || spra === 5) return 2;
  if (spra === 3) return 4;
  if (spra === 7) return 3;
  // variable
  if (sprm === 0xd608 || sprm === 0xd606) return 2 + buf.getUint16(pos + 2, true) - 1;
  if (sprm === 0xc615) {
    const cb = buf.getUint8(pos + 2);
    return cb === 255 ? 1 + buf.getUint8(pos + 3) * 4 + 1 + buf.getUint8(pos + 4 + buf.getUint8(pos + 3) * 4) * 3 + 1 : 1 + cb;
  }
  return 1 + buf.getUint8(pos + 2);
}

function* sprms(buf: DataView, start: number, end: number): Generator<{ sprm: number; at: number }> {
  let pos = start;
  while (pos + 2 <= end) {
    const sprm = buf.getUint16(pos, true);
    const len = sprmLength(buf, pos, sprm);
    yield { sprm, at: pos + 2 };
    pos += 2 + len;
  }
}

function toggle(v: number): boolean | undefined {
  if (v === 1 || v === 0x81) return true;
  if (v === 0) return false;
  return undefined; // 0x80: same as style
}

export function convertLegacyDoc(bytes: Uint8Array): string {
  const cfb = CFB.read(bytes, { type: 'array' });
  const wd = stream(cfb, 'WordDocument');
  if (!wd) throw new Error('This .doc file has no Word document stream');
  const w = new DataView(wd.buffer, wd.byteOffset, wd.byteLength);
  if (w.getUint16(0, true) !== 0xa5ec) throw new Error('Unsupported .doc version (Word 97 or later required)');
  const flags = w.getUint16(0x0a, true);
  if (flags & 0x0100) throw new Error('This .doc is password-protected. Remove the password in Word, then open it again.');
  const tableBytes = stream(cfb, flags & 0x0200 ? '1Table' : '0Table');
  if (!tableBytes) throw new Error('This .doc file is missing its table stream');
  const t = new DataView(tableBytes.buffer, tableBytes.byteOffset, tableBytes.byteLength);

  const fcLcb = (i: number) => [w.getUint32(154 + i * 8, true), w.getUint32(158 + i * 8, true)] as const;
  const ccpText = w.getInt32(0x4c, true);

  // ---- Piece table: CP -> file offset ----
  const [fcClx, lcbClx] = fcLcb(33);
  let pos = fcClx;
  while (pos < fcClx + lcbClx && t.getUint8(pos) === 0x01) pos += 3 + t.getUint16(pos + 1, true);
  if (t.getUint8(pos) !== 0x02) throw new Error('Damaged .doc: piece table not found');
  const lcb = t.getUint32(pos + 1, true);
  const plc = pos + 5;
  const n = (lcb - 4) / 12;
  const chars: string[] = [];
  const fcs: number[] = [];
  const w1252 = new TextDecoder('windows-1252');
  const utf16 = new TextDecoder('utf-16le');
  for (let i = 0; i < n && chars.length < ccpText; i++) {
    const cpStart = t.getUint32(plc + i * 4, true);
    const cpEnd = Math.min(t.getUint32(plc + (i + 1) * 4, true), ccpText);
    if (cpEnd <= cpStart) continue;
    const rawFc = t.getUint32(plc + (n + 1) * 4 + i * 8 + 2, true);
    const compressed = (rawFc & 0x40000000) !== 0;
    const count = cpEnd - cpStart;
    if (compressed) {
      const fc = (rawFc & ~0x40000000) / 2;
      const text = w1252.decode(wd.subarray(fc, fc + count));
      for (let k = 0; k < text.length; k++) (chars.push(text[k]), fcs.push(fc + k));
    } else {
      const text = utf16.decode(wd.subarray(rawFc, rawFc + count * 2));
      for (let k = 0; k < text.length; k++) (chars.push(text[k]), fcs.push(rawFc + k * 2));
    }
  }

  // ---- Stylesheet: istd -> built-in style id ----
  const [fcStshf, lcbStshf] = fcLcb(1);
  const stiByIstd: number[] = [];
  if (lcbStshf > 0) {
    const cbStshi = t.getUint16(fcStshf, true);
    const cstd = t.getUint16(fcStshf + 2, true);
    let p = fcStshf + 2 + cbStshi;
    for (let i = 0; i < cstd && p < fcStshf + lcbStshf; i++) {
      const cbStd = t.getUint16(p, true);
      stiByIstd[i] = cbStd ? t.getUint16(p + 2, true) & 0x0fff : -1;
      p += 2 + cbStd;
    }
  }

  // ---- Font table ----
  const fonts: string[] = [];
  const [fcFfn, lcbFfn] = fcLcb(15);
  if (lcbFfn > 0) {
    const extended = t.getUint16(fcFfn, true) === 0xffff;
    const count = extended ? t.getUint16(fcFfn + 2, true) : t.getUint16(fcFfn, true);
    let p = fcFfn + (extended ? 6 : 4);
    for (let i = 0; i < count && p < fcFfn + lcbFfn; i++) {
      const cch = t.getUint8(p);
      let name = '';
      for (let q = p + 1 + 39; q + 1 < p + 1 + cch; q += 2) {
        const c = t.getUint16(q, true);
        if (!c) break;
        name += String.fromCharCode(c);
      }
      fonts.push(name);
      p += 1 + cch;
    }
  }

  // ---- Formatting pages (FKPs) ----
  const papx: { start: number; end: number; props: ParaProps }[] = [];
  const chpx: { start: number; end: number; props: CharProps }[] = [];
  const readBte = (index: number, cb: (page: number) => void) => {
    const [fc, len] = fcLcb(index);
    if (!len) return;
    const count = (len - 4) / 8;
    for (let i = 0; i < count; i++) cb((t.getUint32(fc + (count + 1) * 4 + i * 4, true) & 0x3fffff) * 512);
  };

  readBte(13, (page) => {
    const crun = w.getUint8(page + 511);
    for (let i = 0; i < crun; i++) {
      const start = w.getUint32(page + i * 4, true);
      const end = w.getUint32(page + (i + 1) * 4, true);
      const bOffset = w.getUint8(page + (crun + 1) * 4 + i * 13);
      const props: ParaProps = { sti: null };
      if (bOffset) {
        let p = page + bOffset * 2;
        let cb = w.getUint8(p);
        let len: number;
        if (cb === 0) {
          cb = w.getUint8(p + 1);
          len = cb * 2;
          p += 2;
        } else {
          len = cb * 2 - 1;
          p += 1;
        }
        const istd = w.getUint16(p, true);
        props.sti = stiByIstd[istd] ?? null;
        for (const { sprm, at } of sprms(w, p + 2, p + len)) {
          switch (sprm) {
            case 0x2416:
              props.inTable = w.getUint8(at) !== 0;
              break;
            case 0x6649:
              if (w.getInt32(at, true) >= 1) props.inTable = true;
              break;
            case 0x2417:
              props.rowEnd = w.getUint8(at) !== 0;
              break;
            case 0x2403:
            case 0x2461:
              props.jc = w.getUint8(at);
              break;
            case 0x840f:
            case 0x845e:
              props.left = w.getInt16(at, true);
              break;
            case 0x840e:
            case 0x845d:
              props.right = w.getInt16(at, true);
              break;
            case 0x8411:
            case 0x8460:
              props.first = w.getInt16(at, true);
              break;
            case 0xa413:
              props.before = w.getUint16(at, true);
              break;
            case 0xa414:
              props.after = w.getUint16(at, true);
              break;
          }
        }
      }
      papx.push({ start, end, props });
    }
  });

  readBte(12, (page) => {
    const crun = w.getUint8(page + 511);
    for (let i = 0; i < crun; i++) {
      const start = w.getUint32(page + i * 4, true);
      const end = w.getUint32(page + (i + 1) * 4, true);
      const off = w.getUint8(page + (crun + 1) * 4 + i);
      const props: CharProps = {};
      if (off) {
        const p = page + off * 2;
        const cb = w.getUint8(p);
        for (const { sprm, at } of sprms(w, p + 1, p + 1 + cb)) {
          const b = () => w.getUint8(at);
          switch (sprm) {
            case 0x0835:
              props.bold = toggle(b());
              break;
            case 0x0836:
              props.italic = toggle(b());
              break;
            case 0x0837:
              props.strike = toggle(b());
              break;
            case 0x2a53:
              props.dstrike = toggle(b());
              break;
            case 0x083b:
              props.caps = toggle(b());
              break;
            case 0x083a:
              props.smallCaps = toggle(b());
              break;
            case 0x083c:
              props.vanish = toggle(b());
              break;
            case 0x0855:
              props.special = b() !== 0;
              break;
            case 0x2a3e:
              props.underline = b() !== 0;
              break;
            case 0x4a43:
              props.size = w.getUint16(at, true);
              break;
            case 0x2a42:
              props.color = ICO[b()] || undefined;
              break;
            case 0x6870: {
              if (w.getUint8(at + 3) === 0xff) break; // cvAuto
              props.color = [0, 1, 2].map((k) => w.getUint8(at + k).toString(16).padStart(2, '0')).join('').toUpperCase();
              break;
            }
            case 0x2a48:
              props.vert = b();
              break;
            case 0x4a4f:
              props.font = fonts[w.getUint16(at, true)];
              break;
          }
        }
      }
      chpx.push({ start, end, props });
    }
  });

  const lookup = <T,>(list: { start: number; end: number; props: T }[], fc: number): T | null => {
    let lo = 0;
    let hi = list.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (fc < list[mid].start) hi = mid - 1;
      else if (fc >= list[mid].end) lo = mid + 1;
      else return list[mid].props;
    }
    return null;
  };
  papx.sort((a, b) => a.start - b.start);
  chpx.sort((a, b) => a.start - b.start);

  // ---- Paragraphs ----
  interface Para {
    runs: { text: string; props: CharProps; br?: 'line' | 'page' }[];
    props: ParaProps;
    cellEnd: boolean;
  }
  const paras: Para[] = [];
  let runs: Para['runs'] = [];
  const fieldStack: ('code' | 'result')[] = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const code = ch.charCodeAt(0);
    const cp = lookup(chpx, fcs[i]) ?? {};
    if (code === 0x13) {
      fieldStack.push('code');
      continue;
    }
    if (code === 0x14) {
      if (fieldStack.length) fieldStack[fieldStack.length - 1] = 'result';
      continue;
    }
    if (code === 0x15) {
      fieldStack.pop();
      continue;
    }
    if (code === 0x0d || code === 0x07) {
      paras.push({ runs, props: lookup(papx, fcs[i]) ?? { sti: null }, cellEnd: code === 0x07 });
      runs = [];
      continue;
    }
    if (fieldStack.includes('code')) continue;
    if (code === 0x0c) runs.push({ text: '', props: cp, br: 'page' });
    else if (code === 0x0b) runs.push({ text: '', props: cp, br: 'line' });
    else if (code === 0x1e) runs.push({ text: '‑', props: cp });
    else if (code === 0x1f) continue;
    else if (cp.special && code < 0x20) continue; // pictures, footnote/annotation references
    else if (code === 0x09 || code >= 0x20) runs.push({ text: ch, props: cp });
  }
  if (runs.length) paras.push({ runs, props: { sti: null }, cellEnd: false });

  // ---- XML ----
  const styleId = (sti: number | null) =>
    sti && sti >= 1 && sti <= 9 ? `Heading${Math.min(sti, 3)}` : sti === 62 ? 'Title' : null;
  const rPr = (c: CharProps) => {
    const p: string[] = [];
    if (c.font) p.push(`<w:rFonts w:ascii="${esc(c.font)}" w:hAnsi="${esc(c.font)}" w:cs="${esc(c.font)}"/>`);
    if (c.bold) p.push('<w:b/>');
    if (c.italic) p.push('<w:i/>');
    if (c.caps) p.push('<w:caps/>');
    if (c.smallCaps) p.push('<w:smallCaps/>');
    if (c.strike) p.push('<w:strike/>');
    if (c.dstrike) p.push('<w:dstrike/>');
    if (c.vanish) p.push('<w:vanish/>');
    if (c.color) p.push(`<w:color w:val="${c.color}"/>`);
    if (c.size) p.push(`<w:sz w:val="${c.size}"/>`);
    if (c.underline) p.push('<w:u w:val="single"/>');
    if (c.vert === 1 || c.vert === 2) p.push(`<w:vertAlign w:val="${c.vert === 1 ? 'superscript' : 'subscript'}"/>`);
    return p.length ? `<w:rPr>${p.join('')}</w:rPr>` : '';
  };
  const paraXml = (para: Para) => {
    const pp = para.props;
    const props: string[] = [];
    const style = styleId(pp.sti);
    if (style) props.push(`<w:pStyle w:val="${style}"/>`);
    if (pp.before !== undefined || pp.after !== undefined) {
      props.push(`<w:spacing${pp.before !== undefined ? ` w:before="${pp.before}"` : ''}${pp.after !== undefined ? ` w:after="${pp.after}"` : ''}/>`);
    }
    if (pp.left || pp.right || pp.first) {
      const first = pp.first ? (pp.first < 0 ? ` w:hanging="${-pp.first}"` : ` w:firstLine="${pp.first}"`) : '';
      props.push(`<w:ind${pp.left ? ` w:left="${pp.left}"` : ''}${pp.right ? ` w:right="${pp.right}"` : ''}${first}/>`);
    }
    if (pp.jc && pp.jc <= 3) props.push(`<w:jc w:val="${['left', 'center', 'right', 'both'][pp.jc]}"/>`);
    // Merge neighbouring characters with identical formatting into one run
    let body = '';
    let buf = '';
    let key = '';
    const flush = () => {
      if (buf) body += `<w:r>${key}<w:t xml:space="preserve">${esc(xmlSafe(buf))}</w:t></w:r>`;
      buf = '';
    };
    for (const r of para.runs) {
      const k = rPr(r.props);
      if (r.br) {
        flush();
        body += `<w:r>${k}${r.br === 'page' ? '<w:br w:type="page"/>' : '<w:br/>'}</w:r>`;
        continue;
      }
      if (r.text === '\t') {
        flush();
        body += `<w:r>${k}<w:tab/></w:r>`;
        continue;
      }
      if (k !== key) flush();
      key = k;
      buf += r.text;
    }
    flush();
    return `<w:p>${props.length ? `<w:pPr>${props.join('')}</w:pPr>` : ''}${body}</w:p>`;
  };

  // In .doc a cell ends with char 7; a row ends with an extra char-7 paragraph flagged as row end
  let out = '';
  let rows: string[][] = [];
  let cells: string[] = [];
  let cell = '';
  const closeTable = () => {
    if (!rows.length && !cells.length && !cell) return;
    if (cell || cells.length) rows.push([...cells, ...(cell ? [cell] : [])]);
    const cols = Math.max(...rows.map((r) => r.length));
    out +=
      `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid>${'<w:gridCol w:w="2000"/>'.repeat(cols)}</w:tblGrid>` +
      rows.map((r) => `<w:tr>${r.map((c) => `<w:tc>${c || '<w:p/>'}</w:tc>`).join('')}${'<w:tc><w:p/></w:tc>'.repeat(cols - r.length)}</w:tr>`).join('') +
      `</w:tbl>`;
    rows = [];
    cells = [];
    cell = '';
  };
  for (const para of paras) {
    if (para.props.inTable) {
      if (para.props.rowEnd) {
        rows.push(cells);
        cells = [];
        cell = '';
      } else {
        cell += paraXml(para);
        if (para.cellEnd) {
          cells.push(cell);
          cell = '';
        }
      }
      continue;
    }
    closeTable();
    out += paraXml(para);
  }
  closeTable();
  return out || '<w:p/>';
}
