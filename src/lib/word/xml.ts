/**
 * Small XML helpers for WordprocessingML. Lookups go by local name and the
 * conventional `w:` / `r:` prefixes (every Word-family producer uses them).
 */

export const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
};

export const REL_TYPE = {
  officeDocument: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  styles: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
  numbering: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering',
  theme: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme',
  image: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
  hyperlink: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
};

export const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

export function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Malformed XML in document package');
  return doc;
}

export const kids = (el: Element | null | undefined): Element[] => {
  const out: Element[] = [];
  if (!el) return out;
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) out.push(n as Element);
  return out;
};

export const child = (el: Element | null | undefined, name: string): Element | null =>
  kids(el).find((c) => c.localName === name) ?? null;

/** First descendant with this local name (depth-first). */
export function descendant(el: Element | null | undefined, name: string): Element | null {
  for (const c of kids(el)) {
    if (c.localName === name) return c;
    const hit = descendant(c, name);
    if (hit) return hit;
  }
  return null;
}

/** `w:val`-style attribute, falling back to the unprefixed name. */
export const wAttr = (el: Element | null | undefined, name: string): string | null =>
  el ? (el.getAttribute(`w:${name}`) ?? el.getAttribute(name)) : null;

export const rAttr = (el: Element | null | undefined, name: string): string | null =>
  el ? el.getAttribute(`r:${name}`) : null;

/** OOXML on/off property: present without val, or val not false/0/off. */
export function onOff(el: Element | null): boolean | null {
  if (!el) return null;
  const v = wAttr(el, 'val');
  return v === null || !['0', 'false', 'off', 'none'].includes(v);
}

export const num = (v: string | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Strip characters XML 1.0 cannot carry (control chars from binary .doc text, etc.). */
export const xmlSafe = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '');

/** xmlns declarations on a part's root element, as `prefix -> uri`. */
export function rootNamespaces(root: Element): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of Array.from(root.attributes)) {
    if (a.name.startsWith('xmlns:')) out.set(a.name.slice(6), a.value);
  }
  return out;
}

/** Serialized element without the xmlns declarations its part root already makes. */
export function outerXml(el: Element, rootNs: Map<string, string>): string {
  return new XMLSerializer()
    .serializeToString(el)
    .replace(/\sxmlns:([\w.-]+)="([^"]*)"/g, (m, p, uri) => (rootNs.get(p) === uri ? '' : m));
}

/** Element tag name from an XML snippet: `<w:keepNext/>` -> `keepNext`. */
export const snippetName = (xml: string) => /^<(?:[\w.-]+:)?([\w.-]+)/.exec(xml)?.[1] ?? '';

/** twips (1/20 pt) -> CSS px at 96 dpi */
export const twipsToPx = (t: number) => t / 15;
export const pxToTwips = (px: number) => Math.round(px * 15);
/** EMU (1/914400 in) -> px */
export const emuToPx = (e: number) => e / 9525;
export const pxToEmu = (px: number) => Math.round(px * 9525);
