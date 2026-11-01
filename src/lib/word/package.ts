import { unzipSync, strFromU8 } from 'fflate';
import { parseXml, kids, child, wAttr, rAttr, num, REL_TYPE, twipsToPx } from './xml';
import { parseStyles, parseThemeFonts, parseNumbering, WordStyles, Numbering, ThemeFonts } from './styles';
import { convertLegacyDoc } from './legacyDoc';
import { createDocxFiles } from './templates';

/**
 * An opened Word package: every original part (kept byte-for-byte for export),
 * plus what rendering needs: styles, numbering, page geometry, header/footer parts.
 */

export interface Rel {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

export interface WordSection {
  /** All px at 96 dpi */
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
  header: number;
  footer: number;
}

export interface WordPackage {
  files: Record<string, Uint8Array>;
  source: 'docx' | 'doc';
  main: string;
  styles: WordStyles;
  numbering: Numbering;
  theme: ThemeFonts;
  section: WordSection;
  /** Default header/footer of the final section; edited alongside the body */
  headerPart: string | null;
  footerPart: string | null;
  text(path: string): string | null;
  rels(part: string): Map<string, Rel>;
  /** Package path a relationship of `part` points at */
  relTarget(part: string, rId: string): string | null;
  mediaUrl(part: string, rId: string): string | null;
  dispose(): void;
}

const isZip = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b;
const isCfb = (b: Uint8Array) => b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;

export const relsPathFor = (part: string) => {
  const i = part.lastIndexOf('/');
  return `${part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels`;
};

export function resolveTarget(part: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = part.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', webp: 'image/webp',
};
export const mimeFor = (path: string) => MIME[path.split('.').pop()!.toLowerCase()] ?? null;

export function loadWordPackage(bytes: Uint8Array): WordPackage {
  let files: Record<string, Uint8Array>;
  let source: WordPackage['source'];
  if (isZip(bytes)) {
    files = unzipSync(bytes);
    source = 'docx';
  } else if (isCfb(bytes)) {
    files = createDocxFiles(convertLegacyDoc(bytes), { identifier: 'converted' });
    source = 'doc';
  } else {
    throw new Error('Not a Word document');
  }

  const textCache = new Map<string, string | null>();
  const text = (path: string) => {
    if (!textCache.has(path)) textCache.set(path, files[path] ? strFromU8(files[path]) : null);
    return textCache.get(path)!;
  };

  const relsCache = new Map<string, Map<string, Rel>>();
  const rels = (part: string) => {
    let map = relsCache.get(part);
    if (map) return map;
    map = new Map();
    const xml = text(relsPathFor(part));
    if (xml) {
      for (const r of kids(parseXml(xml).documentElement)) {
        const id = r.getAttribute('Id');
        if (!id) continue;
        map.set(id, {
          id,
          type: r.getAttribute('Type') || '',
          target: r.getAttribute('Target') || '',
          external: r.getAttribute('TargetMode') === 'External',
        });
      }
    }
    relsCache.set(part, map);
    return map;
  };
  const relTarget = (part: string, rId: string) => {
    const rel = rels(part).get(rId);
    return rel && !rel.external ? resolveTarget(part, rel.target) : null;
  };
  const byType = (part: string, type: string) => {
    for (const r of rels(part).values()) if (r.type === type) return resolveTarget(part, r.target);
    return null;
  };

  const rootRel = [...rels('').values()].find((r) => r.type === REL_TYPE.officeDocument);
  const main = rootRel ? resolveTarget('', rootRel.target) : 'word/document.xml';
  if (!files[main]) throw new Error('This file has no Word document body');

  const themePath = byType(main, REL_TYPE.theme);
  const theme = parseThemeFonts(themePath ? text(themePath) : null);
  const stylesPath = byType(main, REL_TYPE.styles);
  const styles = parseStyles(stylesPath ? text(stylesPath) : null, theme);
  const numberingPath = byType(main, REL_TYPE.numbering);
  const numbering = parseNumbering(numberingPath ? text(numberingPath) : null);

  // Page geometry and header/footer from the last section (body's own sectPr)
  const body = child(parseXml(text(main)!).documentElement, 'body');
  const sectPr = kids(body).reverse().find((k) => k.localName === 'sectPr') ?? null;
  const pgSz = child(sectPr, 'pgSz');
  const pgMar = child(sectPr, 'pgMar');
  const tw = (el: Element | null, name: string, dflt: number) => twipsToPx(num(wAttr(el, name)) ?? dflt);
  const section: WordSection = {
    width: tw(pgSz, 'w', 12240),
    height: tw(pgSz, 'h', 15840),
    top: Math.abs(tw(pgMar, 'top', 1440)),
    right: tw(pgMar, 'right', 1440),
    bottom: Math.abs(tw(pgMar, 'bottom', 1440)),
    left: tw(pgMar, 'left', 1440),
    header: tw(pgMar, 'header', 720),
    footer: tw(pgMar, 'footer', 720),
  };
  if (wAttr(pgSz, 'orient') === 'landscape' && section.width < section.height) {
    [section.width, section.height] = [section.height, section.width];
  }
  const ref = (name: string) => {
    const el = kids(sectPr).find((k) => k.localName === name && (wAttr(k, 'type') ?? 'default') === 'default');
    const id = rAttr(el, 'id');
    const path = id ? relTarget(main, id) : null;
    return path && files[path] ? path : null;
  };

  const urls = new Map<string, string | null>();
  const mediaUrl = (part: string, rId: string) => {
    const path = relTarget(part, rId);
    if (!path) return null;
    if (!urls.has(path)) {
      const mime = mimeFor(path);
      const data = files[path];
      urls.set(path, mime && data ? URL.createObjectURL(new Blob([data as BlobPart], { type: mime })) : null);
    }
    return urls.get(path)!;
  };

  return {
    files,
    source,
    main,
    styles,
    numbering,
    theme,
    section,
    headerPart: ref('headerReference'),
    footerPart: ref('footerReference'),
    text,
    rels,
    relTarget,
    mediaUrl,
    dispose: () => {
      for (const u of urls.values()) if (u) URL.revokeObjectURL(u);
      urls.clear();
    },
  };
}
