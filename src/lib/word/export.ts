import { zipSync, strToU8, strFromU8 } from 'fflate';
import { WordPackage, relsPathFor, resolveTarget } from './package';
import { WordNodeJSON } from './schema';
import { APP_LISTS, AppListId } from './styles';
import { BUILTIN_STYLES } from './templates';
import { esc, xmlSafe, snippetName, pxToTwips, pxToEmu, NS, REL_TYPE, XML_DECL } from './xml';

/**
 * ProseMirror JSON -> DOCX. The original package is the template: every part
 * the editor does not own (styles, settings, footnotes, comments, media, other
 * headers/footers, the final sectPr) is written back byte-for-byte, and only the
 * edited parts' content is regenerated.
 */

const RPR_ORDER = ['rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike', 'outline', 'shadow', 'emboss', 'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden', 'color', 'spacing', 'w', 'kern', 'position', 'sz', 'szCs', 'highlight', 'u', 'effect', 'bdr', 'shd', 'fitText', 'vertAlign', 'rtl', 'cs', 'em', 'lang', 'eastAsianLayout', 'specVanish', 'oMath', 'rPrChange'];
const PPR_ORDER = ['pStyle', 'keepNext', 'keepLines', 'pageBreakBefore', 'framePr', 'widowControl', 'numPr', 'suppressLineNumbers', 'pBdr', 'shd', 'tabs', 'suppressAutoHyphens', 'kinsoku', 'wordWrap', 'overflowPunct', 'topLinePunct', 'autoSpaceDE', 'autoSpaceDN', 'bidi', 'adjustRightInd', 'snapToGrid', 'spacing', 'ind', 'contextualSpacing', 'mirrorIndents', 'suppressOverlap', 'jc', 'textDirection', 'textAlignment', 'textboxTightWrap', 'outlineLvl', 'divId', 'cnfStyle', 'rPr', 'sectPr', 'pPrChange'];
const TCPR_ORDER = ['cnfStyle', 'tcW', 'gridSpan', 'hMerge', 'vMerge', 'tcBorders', 'shd', 'noWrap', 'tcMar', 'textDirection', 'tcFitText', 'vAlign', 'hideMark', 'headers', 'cellIns', 'cellDel', 'cellMerge', 'tcPrChange'];

/** Schema order, first occurrence of each element wins (generated before preserved). */
function ordered(snippets: string[], order: string[]): string {
  const seen = new Set<string>();
  const rank = (n: string) => {
    const i = order.indexOf(n);
    return i === -1 ? order.length - 1.5 : i; // unknown: just before the *Change element
  };
  return snippets
    .map((xml) => ({ xml, name: snippetName(xml) }))
    .filter(({ name }) => (seen.has(name) ? false : (seen.add(name), true)))
    .map((s, i) => ({ ...s, i }))
    .sort((a, b) => rank(a.name) - rank(b.name) || a.i - b.i)
    .map((s) => s.xml)
    .join('');
}

const parseList = (json: string | null | undefined): string[] => {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

/** Generated self-closing element plus the attributes only the preserved original had. */
function mergeAttrs(generated: string | null, raw: string | undefined, known: string[]): string | null {
  if (!raw) return generated;
  const extra = [...raw.matchAll(/\s([\w:.-]+)="([^"]*)"/g)]
    .filter(([, name]) => !known.includes(name) && !name.startsWith('xmlns'))
    .map(([m]) => m)
    .join('');
  if (!generated) return extra ? `<${raw.match(/^<([\w:.-]+)/)![1]}${extra}/>` : null;
  return generated.replace(/\/>$/, `${extra}/>`);
}

interface PartCtx {
  part: string;
  existingRels: Map<string, { target: string; type: string }>;
  newRels: { id: string; type: string; target: string; external: boolean }[];
}

interface Ctx {
  pkg: WordPackage;
  files: Record<string, Uint8Array>;
  listIds: Record<AppListId, number>;
  usedLists: Set<AppListId>;
  usedStyles: Set<string>;
  newMediaExt: Set<string>;
  contentWidth: number;
  counter: number;
}

export interface ExportInput {
  /** part path -> edited content */
  parts: Record<string, WordNodeJSON>;
}

export function exportDocx(pkg: WordPackage, input: ExportInput): Uint8Array {
  const files: Record<string, Uint8Array> = { ...pkg.files };
  const ctx: Ctx = {
    pkg,
    files,
    listIds: allocateListIds(pkg),
    usedLists: new Set(),
    usedStyles: new Set(),
    newMediaExt: new Set(),
    contentWidth: pkg.section.width - pkg.section.left - pkg.section.right,
    counter: 0,
  };

  for (const [part, doc] of Object.entries(input.parts)) {
    const original = pkg.text(part);
    if (!original) continue;
    const pctx: PartCtx = {
      part,
      existingRels: new Map([...pkg.rels(part).values()].map((r) => [r.id, { target: r.target, type: r.type }])),
      newRels: [],
    };
    const body = blocksXml(ctx, pctx, doc.content ?? [], part === pkg.main);
    files[part] = strToU8(replacePartContent(original, part === pkg.main, body));
    if (pctx.newRels.length) files[relsPathFor(part)] = strToU8(addRels(pkg.text(relsPathFor(part)), pctx.newRels));
  }

  writeNumbering(ctx);
  writeStyles(ctx);
  if (ctx.newMediaExt.size) addContentTypeDefaults(ctx);

  // [Content_Types].xml first, as Office writes it
  const ordered: Record<string, Uint8Array> = {};
  if (files['[Content_Types].xml']) ordered['[Content_Types].xml'] = files['[Content_Types].xml'];
  for (const [k, v] of Object.entries(files)) if (k !== '[Content_Types].xml') ordered[k] = v;
  return zipSync(ordered, { level: 6 });
}

// ================= Part surgery =================

/** Swap a part's content, leaving its root element (namespaces, mc:Ignorable) and final sectPr untouched. */
function replacePartContent(xml: string, isMain: boolean, content: string): string {
  const rootMatch = /<([\w.-]+:)?(document|hdr|ftr)\b[^>]*>/.exec(xml);
  if (!rootMatch) throw new Error('Unrecognised Word part');
  const prefix = rootMatch[1] ?? '';
  let rootTag = rootMatch[0];
  for (const [p, uri] of [['w', NS.w], ['r', NS.r]] as const) {
    if (!new RegExp(`\\sxmlns:${p}=`).test(rootTag)) rootTag = rootTag.replace(/\/?>$/, (end) => ` xmlns:${p}="${uri}"${end}`);
  }
  const head = xml.slice(0, rootMatch.index) + rootTag;
  const afterRoot = xml.slice(rootMatch.index + rootMatch[0].length);

  if (!isMain) {
    const close = `</${prefix}${rootMatch[2]}>`;
    return head + content + afterRoot.slice(afterRoot.lastIndexOf(close));
  }
  const bodyOpen = new RegExp(`<${prefix}body\\b[^>]*>`).exec(afterRoot);
  const bodyClose = afterRoot.lastIndexOf(`</${prefix}body>`);
  if (!bodyOpen || bodyClose < 0) throw new Error('Word document has no body');
  const bodyStart = bodyOpen.index + bodyOpen[0].length;
  // Keep the body-level sectPr: the last element, directly before </w:body>
  let tail = afterRoot.slice(bodyClose);
  const sectAt = afterRoot.lastIndexOf(`<${prefix}sectPr`, bodyClose);
  if (sectAt >= bodyStart) {
    const sect = afterRoot.slice(sectAt, bodyClose);
    if (/^<[\w:.-]+(\s[^>]*)?(\/>|>[\s\S]*<\/[\w:.-]*sectPr>)\s*$/.test(sect) && !/<\/[\w:.-]*pPr>/.test(sect)) tail = sect + tail;
  }
  return head + afterRoot.slice(0, bodyStart) + content + tail;
}

function addRels(existing: string | null, rels: PartCtx['newRels']): string {
  const entries = rels
    .map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${esc(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`)
    .join('');
  if (!existing) return `${XML_DECL}<Relationships xmlns="${NS.rel}">${entries}</Relationships>`;
  return existing.replace(/<\/Relationships>\s*$/, `${entries}</Relationships>`);
}

function newRelId(pctx: PartCtx): string {
  let n = pctx.existingRels.size + pctx.newRels.length + 1;
  const taken = (id: string) => pctx.existingRels.has(id) || pctx.newRels.some((r) => r.id === id);
  while (taken(`rIdEd${n}`)) n++;
  return `rIdEd${n}`;
}

// ================= Blocks =================

function blocksXml(ctx: Ctx, pctx: PartCtx, nodes: WordNodeJSON[], needsTrailingParagraph = false): string {
  let out = nodes.map((n) => blockXml(ctx, pctx, n)).join('');
  // Word needs a paragraph after a final table (in cells and at the end of the body)
  if (needsTrailingParagraph && nodes.length && nodes[nodes.length - 1].type === 'table') out += '<w:p/>';
  return out;
}

function blockXml(ctx: Ctx, pctx: PartCtx, n: WordNodeJSON): string {
  switch (n.type) {
    case 'paragraph':
      return paragraphXml(ctx, pctx, n);
    case 'table':
      return tableXml(ctx, pctx, n);
    case 'raw_block':
      return n.attrs?.xml || '';
    default:
      return '';
  }
}

function paragraphXml(ctx: Ctx, pctx: PartCtx, n: WordNodeJSON): string {
  const a = n.attrs ?? {};
  const extras = parseList(a.pPrX);
  const raw = (name: string) => extras.find((x) => snippetName(x) === name);
  const props: string[] = [];
  if (a.style) {
    props.push(`<w:pStyle w:val="${esc(a.style)}"/>`);
    ctx.usedStyles.add(a.style);
  }
  if (a.numId != null) {
    const id = a.numId in APP_LISTS ? (ctx.usedLists.add(a.numId as AppListId), String(ctx.listIds[a.numId as AppListId])) : a.numId;
    props.push(`<w:numPr><w:ilvl w:val="${a.ilvl ?? 0}"/><w:numId w:val="${esc(String(id))}"/></w:numPr>`);
  }
  const sp = [
    a.spBefore != null ? ` w:before="${a.spBefore}"` : '',
    a.spAfter != null ? ` w:after="${a.spAfter}"` : '',
    a.line != null ? ` w:line="${a.line}" w:lineRule="${a.lineRule || 'auto'}"` : '',
  ].join('');
  const spacing = mergeAttrs(sp ? `<w:spacing${sp}/>` : null, raw('spacing'), ['w:before', 'w:after', 'w:line', 'w:lineRule']);
  if (spacing) props.push(spacing);
  const ind = [
    a.indL != null ? ` w:left="${a.indL}"` : '',
    a.indR != null ? ` w:right="${a.indR}"` : '',
    a.indFirst != null ? (a.indFirst < 0 ? ` w:hanging="${-a.indFirst}"` : ` w:firstLine="${a.indFirst}"`) : '',
  ].join('');
  const indent = mergeAttrs(ind ? `<w:ind${ind}/>` : null, raw('ind'), ['w:left', 'w:start', 'w:right', 'w:end', 'w:firstLine', 'w:hanging']);
  if (indent) props.push(indent);
  if (a.align) props.push(`<w:jc w:val="${a.align === 'justify' ? 'both' : a.align}"/>`);
  if (a.markRpr) props.push(a.markRpr);
  props.push(...extras.filter((x) => !['spacing', 'ind'].includes(snippetName(x))));
  const pPr = props.length ? `<w:pPr>${ordered(props, PPR_ORDER)}</w:pPr>` : '';
  return `<w:p>${pPr}${inlinesXml(ctx, pctx, n.content ?? [])}</w:p>`;
}

type MarkJSON = { type: string; attrs?: Record<string, any> };
const sameLink = (a?: MarkJSON, b?: MarkJSON) =>
  !!a && !!b && a.attrs?.href === b.attrs?.href && a.attrs?.anchor === b.attrs?.anchor && a.attrs?.rId === b.attrs?.rId;

function inlinesXml(ctx: Ctx, pctx: PartCtx, nodes: WordNodeJSON[]): string {
  let out = '';
  for (let i = 0; i < nodes.length; ) {
    const link = nodes[i].marks?.find((m) => m.type === 'link');
    if (!link) {
      out += inlineXml(ctx, pctx, nodes[i++]);
      continue;
    }
    let inner = '';
    while (i < nodes.length && sameLink(nodes[i].marks?.find((m) => m.type === 'link'), link)) inner += inlineXml(ctx, pctx, nodes[i++]);
    out += hyperlinkXml(pctx, link, inner);
  }
  return out;
}

function hyperlinkXml(pctx: PartCtx, link: MarkJSON, inner: string): string {
  const { href, rId, anchor } = link.attrs ?? {};
  if (anchor && !href) return `<w:hyperlink w:anchor="${esc(anchor)}" w:history="1">${inner}</w:hyperlink>`;
  if (!href) return inner;
  let id = rId && pctx.existingRels.get(rId)?.target === href ? rId : null;
  if (!id) {
    id = newRelId(pctx);
    pctx.newRels.push({ id, type: REL_TYPE.hyperlink, target: href, external: true });
  }
  return `<w:hyperlink r:id="${id}"${anchor ? ` w:anchor="${esc(anchor)}"` : ''} w:history="1">${inner}</w:hyperlink>`;
}

function rPrXml(ctx: Ctx, marks: MarkJSON[] = []): string {
  const props: string[] = [];
  for (const m of marks) {
    const a = m.attrs ?? {};
    switch (m.type) {
      case 'rstyle':
        props.push(`<w:rStyle w:val="${esc(a.id)}"/>`);
        ctx.usedStyles.add(a.id);
        break;
      case 'font':
        props.push(a.xml || `<w:rFonts w:ascii="${esc(a.family)}" w:hAnsi="${esc(a.family)}" w:cs="${esc(a.family)}"/>`);
        break;
      case 'bold':
        props.push(a.on === false ? '<w:b w:val="0"/>' : '<w:b/>');
        break;
      case 'italic':
        props.push(a.on === false ? '<w:i w:val="0"/>' : '<w:i/>');
        break;
      case 'underline':
        props.push(`<w:u w:val="${esc(a.val || 'single')}"${a.color ? ` w:color="${esc(a.color)}"` : ''}/>`);
        break;
      case 'strike':
        props.push(a.double ? '<w:dstrike/>' : '<w:strike/>');
        break;
      case 'vertAlign':
        props.push(`<w:vertAlign w:val="${esc(a.val)}"/>`);
        break;
      case 'size':
        props.push(`<w:sz w:val="${a.halfPts}"/>`);
        break;
      case 'color':
        props.push(a.xml || `<w:color w:val="${esc(a.val)}"/>`);
        break;
      case 'highlight':
        props.push(`<w:highlight w:val="${esc(a.val)}"/>`);
        break;
      case 'shade':
        props.push(`<w:shd w:val="clear" w:color="auto" w:fill="${esc(a.fill)}"/>`);
        break;
      case 'rprx':
        props.push(...parseList(a.xml));
        break;
    }
  }
  return props.length ? `<w:rPr>${ordered(props, RPR_ORDER)}</w:rPr>` : '';
}

function textRuns(rPr: string, text: string): string {
  // Characters Word stores as elements rather than text
  return text
    .split(/(‑|­)/)
    .filter(Boolean)
    .map((seg) => {
      if (seg === '‑') return `<w:r>${rPr}<w:noBreakHyphen/></w:r>`;
      if (seg === '­') return `<w:r>${rPr}<w:softHyphen/></w:r>`;
      return `<w:r>${rPr}<w:t xml:space="preserve">${esc(xmlSafe(seg))}</w:t></w:r>`;
    })
    .join('');
}

function inlineXml(ctx: Ctx, pctx: PartCtx, n: WordNodeJSON): string {
  const rPr = rPrXml(ctx, n.marks?.filter((m) => m.type !== 'link'));
  const a = n.attrs ?? {};
  switch (n.type) {
    case 'text':
      return textRuns(rPr, n.text || '');
    case 'tab':
      return `<w:r>${rPr}<w:tab/></w:r>`;
    case 'hard_break':
      return `<w:r>${rPr}${a.type ? `<w:br w:type="${a.type}"/>` : '<w:br/>'}</w:r>`;
    case 'image':
      return `<w:r>${rPr}${imageXml(ctx, pctx, a)}</w:r>`;
    case 'raw_inline':
      return a.level === 'para' ? a.xml || '' : `<w:r>${rPr}${a.xml || ''}</w:r>`;
    default:
      return '';
  }
}

// ================= Images =================

function imageXml(ctx: Ctx, pctx: PartCtx, a: Record<string, any>): string {
  const cx = pxToEmu(a.width);
  const cy = pxToEmu(a.height);
  if (a.xml && a.rId) {
    // Original drawing: only the size can have changed
    return a.xml
      .replace(/(<wp:extent\b[^>]*?\bcx=")\d+("[^>]*?\bcy=")\d+/, `$1${cx}$2${cy}`)
      .replace(/(<a:ext\b[^>]*?\bcx=")\d+("[^>]*?\bcy=")\d+/, `$1${cx}$2${cy}`);
  }
  const data = /^data:(image\/[\w+.-]+);base64,(.*)$/.exec(a.src || '');
  if (!data) return '';
  const ext = data[1] === 'image/jpeg' ? 'jpeg' : data[1].split('/')[1].replace('svg+xml', 'svg');
  const n = ++ctx.counter;
  let media = `word/media/editordoc${n}.${ext}`;
  while (ctx.files[media]) media = `word/media/editordoc${n}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
  ctx.files[media] = Uint8Array.from(atob(data[2]), (c) => c.charCodeAt(0));
  ctx.newMediaExt.add(ext);
  const rId = newRelId(pctx);
  const partDir = pctx.part.split('/').slice(0, -1).join('/');
  pctx.newRels.push({ id: rId, type: REL_TYPE.image, target: media.startsWith(partDir + '/') ? media.slice(partDir.length + 1) : `/${media}`, external: false });
  const id = 4000 + n;
  const alt = esc(a.alt || '');
  return (
    `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="${NS.wp}"><wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:docPr id="${id}" name="Picture ${id}" descr="${alt}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="${NS.a}" noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic xmlns:a="${NS.a}"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="${NS.pic}">` +
    `<pic:nvPicPr><pic:cNvPr id="${id}" name="Picture ${id}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`
  );
}

// ================= Tables =================

function tableXml(ctx: Ctx, pctx: PartCtx, n: WordNodeJSON): string {
  const a = n.attrs ?? {};
  const rows = n.content ?? [];
  let tblPr = a.tblPrX as string;
  if (!tblPr) {
    const style = a.style || 'TableGrid';
    ctx.usedStyles.add(style);
    tblPr = `<w:tblPr><w:tblStyle w:val="${esc(style)}"/><w:tblW w:w="0" w:type="auto"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>`;
  }

  // Lay cells onto the grid (rowspans occupy columns in the rows below)
  type Placed = { col: number; span: number; cell?: WordNodeJSON };
  const pending = new Map<number, { left: number; span: number }>();
  const layout: Placed[][] = [];
  const widths: number[] = [];
  for (const row of rows) {
    const placed: Placed[] = [];
    let col = 0;
    const flushAt = () => {
      for (let p = pending.get(col); p; p = pending.get(col)) {
        placed.push({ col, span: p.span });
        if (--p.left === 0) pending.delete(col);
        col += p.span;
      }
    };
    for (const cell of row.content ?? []) {
      flushAt();
      const span = cell.attrs?.colspan ?? 1;
      const cw: number[] | null = cell.attrs?.colwidth ?? null;
      cw?.forEach((w, k) => w && (widths[col + k] = widths[col + k] ?? w));
      placed.push({ col, span, cell });
      if ((cell.attrs?.rowspan ?? 1) > 1) pending.set(col, { left: cell.attrs!.rowspan - 1, span });
      col += span;
    }
    for (const [c, p] of [...pending.entries()].sort((x, y) => x[0] - y[0])) {
      if (c < col || placed.some((pl) => pl.col === c)) continue;
      placed.push({ col: c, span: p.span });
      if (--p.left === 0) pending.delete(c);
    }
    layout.push(placed);
  }
  const colCount = Math.max(1, ...layout.map((r) => r.reduce((m, p) => Math.max(m, p.col + p.span), 0)));
  const fallback = ctx.contentWidth / colCount;
  const colTw = Array.from({ length: colCount }, (_, i) => pxToTwips(widths[i] || fallback));
  const grid = `<w:tblGrid>${colTw.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`;

  const rowsXml = rows
    .map((row, r) => {
      const trPr = parseList(row.attrs?.trPrX).join('');
      const cells = layout[r]
        .map(({ col, span, cell }) => {
          const width = colTw.slice(col, col + span).reduce((s, w) => s + w, 0);
          const props = [`<w:tcW w:w="${width}" w:type="dxa"/>`];
          if (span > 1) props.push(`<w:gridSpan w:val="${span}"/>`);
          if (!cell) return `<w:tc><w:tcPr>${ordered([...props, '<w:vMerge/>'], TCPR_ORDER)}</w:tcPr><w:p/></w:tc>`;
          const ca = cell.attrs ?? {};
          if (ca.rowspan > 1) props.push('<w:vMerge w:val="restart"/>');
          if (ca.shade) props.push(`<w:shd w:val="clear" w:color="auto" w:fill="${esc(ca.shade)}"/>`);
          if (ca.vAlign) props.push(`<w:vAlign w:val="${esc(ca.vAlign)}"/>`);
          props.push(...parseList(ca.tcPrX));
          const content = cell.content ?? [];
          let inner = blocksXml(ctx, pctx, content);
          if (!content.length || content[content.length - 1].type !== 'paragraph') inner += '<w:p/>';
          return `<w:tc><w:tcPr>${ordered(props, TCPR_ORDER)}</w:tcPr>${inner}</w:tc>`;
        })
        .join('');
      return `<w:tr>${trPr}${cells}</w:tr>`;
    })
    .join('');
  return `<w:tbl>${tblPr}${grid}${rowsXml}</w:tbl>`;
}

// ================= Numbering, styles, content types =================

function partByType(pkg: WordPackage, type: string): string | null {
  for (const r of pkg.rels(pkg.main).values()) if (r.type === type) return resolveTarget(pkg.main, r.target);
  return null;
}

function allocateListIds(pkg: WordPackage): Record<AppListId, number> {
  const path = partByType(pkg, REL_TYPE.numbering);
  const xml = path ? pkg.text(path) || '' : '';
  const max = Math.max(0, ...[...xml.matchAll(/<w:num\s[^>]*w:numId="(\d+)"/g)].map((m) => Number(m[1])));
  return { 'app-bullet': max + 1, 'app-decimal': max + 2 };
}

function abstractNumXml(kind: AppListId, abstractId: number): string {
  const def = APP_LISTS[kind];
  const fmts = ['decimal', 'lowerLetter', 'lowerRoman'];
  const levels = def.texts
    .map(
      (text, i) =>
        `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${def.fmt === 'bullet' ? 'bullet' : fmts[i % 3]}"/>` +
        `<w:lvlText w:val="${esc(text)}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (i + 1)}" w:hanging="360"/></w:pPr></w:lvl>`
    )
    .join('');
  return `<w:abstractNum w:abstractNumId="${abstractId}"><w:multiLevelType w:val="hybridMultilevel"/>${levels}</w:abstractNum>`;
}

function ensurePart(ctx: Ctx, path: string, relType: string, contentType: string, rootXml: string): string {
  if (ctx.files[path]) return strFromU8(ctx.files[path]);
  const relsPath = relsPathFor(ctx.pkg.main);
  const relsXml = ctx.files[relsPath] ? strFromU8(ctx.files[relsPath]) : null;
  const ids = new Set([...(relsXml ?? '').matchAll(/Id="([^"]+)"/g)].map((m) => m[1]));
  let n = ids.size + 1;
  while (ids.has(`rIdEd${n}`)) n++;
  ctx.files[relsPath] = strToU8(addRels(relsXml, [{ id: `rIdEd${n}`, type: relType, target: path.replace(/^word\//, ''), external: false }]));
  const ct = strFromU8(ctx.files['[Content_Types].xml']);
  ctx.files['[Content_Types].xml'] = strToU8(ct.replace('</Types>', `<Override PartName="/${path}" ContentType="${contentType}"/></Types>`));
  return rootXml;
}

function writeNumbering(ctx: Ctx) {
  if (!ctx.usedLists.size) return;
  const path = partByType(ctx.pkg, REL_TYPE.numbering) ?? 'word/numbering.xml';
  let xml = ensurePart(
    ctx,
    path,
    REL_TYPE.numbering,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml',
    `${XML_DECL}<w:numbering xmlns:w="${NS.w}"></w:numbering>`
  );
  const maxAbstract = Math.max(0, ...[...xml.matchAll(/w:abstractNumId="(\d+)"/g)].map((m) => Number(m[1])));
  let abstracts = '';
  let nums = '';
  [...ctx.usedLists].forEach((kind, i) => {
    abstracts += abstractNumXml(kind, maxAbstract + 1 + i);
    nums += `<w:num w:numId="${ctx.listIds[kind]}"><w:abstractNumId w:val="${maxAbstract + 1 + i}"/></w:num>`;
  });
  // Schema order: every abstractNum before the first num
  const firstNum = xml.search(/<w:num\s/);
  xml = firstNum >= 0 ? xml.slice(0, firstNum) + abstracts + xml.slice(firstNum) : xml.replace('</w:numbering>', `${abstracts}</w:numbering>`);
  xml = xml.replace(/<\/w:numbering>\s*$/, `${nums}</w:numbering>`);
  ctx.files[path] = strToU8(xml);
}

function writeStyles(ctx: Ctx) {
  const missing = [...ctx.usedStyles].filter((id) => !ctx.pkg.styles.byId.has(id) && BUILTIN_STYLES[id]);
  if (!missing.length) return;
  if (!ctx.pkg.styles.byId.has('Normal') && !missing.includes('Normal')) missing.unshift('Normal');
  const path = partByType(ctx.pkg, REL_TYPE.styles) ?? 'word/styles.xml';
  const xml = ensurePart(
    ctx,
    path,
    REL_TYPE.styles,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml',
    `${XML_DECL}<w:styles xmlns:w="${NS.w}"></w:styles>`
  );
  ctx.files[path] = strToU8(xml.replace(/<\/w:styles>\s*$/, `${missing.map((id) => BUILTIN_STYLES[id]).join('')}</w:styles>`));
}

function addContentTypeDefaults(ctx: Ctx) {
  let ct = strFromU8(ctx.files['[Content_Types].xml']);
  const mime: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp' };
  for (const ext of ctx.newMediaExt) {
    if (new RegExp(`Extension="${ext}"`, 'i').test(ct)) continue;
    ct = ct.replace('</Types>', `<Default Extension="${ext}" ContentType="${mime[ext] ?? 'application/octet-stream'}"/></Types>`);
  }
  ctx.files['[Content_Types].xml'] = strToU8(ct);
}
