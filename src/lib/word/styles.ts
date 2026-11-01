import { child, kids, wAttr, onOff, num, parseXml, descendant } from './xml';
import { cssFontStack, HIGHLIGHT_CSS } from './schema';

/**
 * styles.xml / theme / numbering.xml -> CSS and list definitions, so a document
 * renders with its own styles (inheritance via basedOn) instead of app defaults.
 */

export interface StyleInfo {
  id: string;
  name: string;
  type: string;
  basedOn: string | null;
  next: string | null;
  /** 0-based outline level (headings), for the navigation pane */
  outline: number | null;
  quick: boolean;
  numId: string | null;
  ilvl: number;
}

export interface WordStyles {
  css: string;
  byId: Map<string, StyleInfo>;
  /** Styles offered in the style picker */
  paragraphStyles: StyleInfo[];
  defaultParagraph: string | null;
}

export interface ThemeFonts {
  major: string | null;
  minor: string | null;
}

export function parseThemeFonts(themeXml: string | null): ThemeFonts {
  if (!themeXml) return { major: null, minor: null };
  const root = parseXml(themeXml).documentElement;
  const scheme = descendant(root, 'fontScheme');
  const face = (name: string) => child(child(scheme, name), 'latin')?.getAttribute('typeface') || null;
  return { major: face('majorFont'), minor: face('minorFont') };
}

type Css = Record<string, string>;

export function fontFromRFonts(rFonts: Element | null, theme: ThemeFonts): string | null {
  if (!rFonts) return null;
  const direct = wAttr(rFonts, 'ascii') || wAttr(rFonts, 'hAnsi');
  if (direct) return direct;
  const th = wAttr(rFonts, 'asciiTheme') || wAttr(rFonts, 'hAnsiTheme');
  if (th) return (th.startsWith('major') ? theme.major : theme.minor) || null;
  return null;
}

export function rPrCss(rPr: Element | null, theme: ThemeFonts): Css {
  const css: Css = {};
  if (!rPr) return css;
  const font = fontFromRFonts(child(rPr, 'rFonts'), theme);
  if (font) css['font-family'] = cssFontStack(font);
  const b = onOff(child(rPr, 'b'));
  if (b !== null) css['font-weight'] = b ? '700' : '400';
  const i = onOff(child(rPr, 'i'));
  if (i !== null) css['font-style'] = i ? 'italic' : 'normal';
  const sz = num(wAttr(child(rPr, 'sz'), 'val'));
  if (sz) css['font-size'] = `${sz / 2}pt`;
  const color = wAttr(child(rPr, 'color'), 'val');
  if (color && color !== 'auto') css.color = `#${color}`;
  const u = child(rPr, 'u');
  const strike = onOff(child(rPr, 'strike'));
  const deco: string[] = [];
  if (u && wAttr(u, 'val') !== 'none') deco.push('underline');
  if (strike) deco.push('line-through');
  if (deco.length) css['text-decoration'] = deco.join(' ');
  if (onOff(child(rPr, 'caps'))) css['text-transform'] = 'uppercase';
  if (onOff(child(rPr, 'smallCaps'))) css['font-variant'] = 'small-caps';
  const hl = wAttr(child(rPr, 'highlight'), 'val');
  if (hl && HIGHLIGHT_CSS[hl]) css['background-color'] = HIGHLIGHT_CSS[hl];
  const spacing = num(wAttr(child(rPr, 'spacing'), 'val'));
  if (spacing) css['letter-spacing'] = `${spacing / 20}pt`;
  return css;
}

export function pPrCss(pPr: Element | null): Css {
  const css: Css = {};
  if (!pPr) return css;
  const sp = child(pPr, 'spacing');
  if (sp) {
    const before = num(wAttr(sp, 'before'));
    const after = num(wAttr(sp, 'after'));
    const line = num(wAttr(sp, 'line'));
    if (before !== null) css['padding-top'] = `${before / 20}pt`;
    if (after !== null) css['padding-bottom'] = `${after / 20}pt`;
    if (line !== null) {
      const rule = wAttr(sp, 'lineRule');
      css['line-height'] = !rule || rule === 'auto' ? ((line / 240) * 1.15).toFixed(3) : `${line / 20}pt`;
    }
  }
  const jc = wAttr(child(pPr, 'jc'), 'val');
  const align = jcToAlign(jc);
  if (align) css['text-align'] = align;
  const ind = child(pPr, 'ind');
  if (ind) {
    const left = num(wAttr(ind, 'left') ?? wAttr(ind, 'start'));
    const right = num(wAttr(ind, 'right') ?? wAttr(ind, 'end'));
    const first = num(wAttr(ind, 'firstLine'));
    const hanging = num(wAttr(ind, 'hanging'));
    if (left !== null) css['padding-left'] = `${left / 15}px`;
    if (right !== null) css['padding-right'] = `${right / 15}px`;
    if (hanging !== null) css['text-indent'] = `${-hanging / 15}px`;
    else if (first !== null) css['text-indent'] = `${first / 15}px`;
  }
  if (onOff(child(pPr, 'pageBreakBefore'))) css['break-before'] = 'page';
  return css;
}

export function jcToAlign(jc: string | null): string | null {
  switch (jc) {
    case 'left':
    case 'start':
      return 'left';
    case 'center':
      return 'center';
    case 'right':
    case 'end':
      return 'right';
    case 'both':
    case 'distribute':
      return 'justify';
    default:
      return null;
  }
}

const cssText = (css: Css) =>
  Object.entries(css)
    .map(([k, v]) => `${k}:${v}`)
    .join(';');

const sel = (id: string) => id.replace(/["\\]/g, '\\$&');

export function parseStyles(stylesXml: string | null, theme: ThemeFonts): WordStyles {
  const byId = new Map<string, StyleInfo>();
  const rules: string[] = [];
  let defaultParagraph: string | null = null;
  if (!stylesXml) return { css: '', byId, paragraphStyles: [], defaultParagraph };

  const root = parseXml(stylesXml).documentElement;
  const defaults = child(root, 'docDefaults');
  const baseRun = rPrCss(child(child(defaults, 'rPrDefault'), 'rPr'), theme);
  const basePara = pPrCss(child(child(defaults, 'pPrDefault'), 'pPr'));
  // Word's built-in defaults when docDefaults omit them: 10pt Times, no spacing
  rules.push(`.wd-doc{${cssText({ 'font-size': '10pt', ...baseRun })}}`);
  if (Object.keys(basePara).length) rules.push(`.wd-doc .wd-p{${cssText(basePara)}}`);

  const raw = new Map<string, { el: Element; type: string; basedOn: string | null }>();
  for (const s of kids(root).filter((k) => k.localName === 'style')) {
    const id = wAttr(s, 'styleId');
    if (!id) continue;
    const type = wAttr(s, 'type') || 'paragraph';
    const basedOn = wAttr(child(s, 'basedOn'), 'val');
    raw.set(id, { el: s, type, basedOn });
    const name = wAttr(child(s, 'name'), 'val') || id;
    const pPr = child(s, 'pPr');
    const numPr = child(pPr, 'numPr');
    const outlineLvl = num(wAttr(child(pPr, 'outlineLvl'), 'val'));
    const headingN = /^heading\s*(\d)$/i.exec(name);
    byId.set(id, {
      id,
      name: displayStyleName(name),
      type,
      basedOn,
      next: wAttr(child(s, 'next'), 'val'),
      outline: outlineLvl !== null && outlineLvl < 9 ? outlineLvl : headingN ? Number(headingN[1]) - 1 : null,
      quick: Boolean(child(s, 'qFormat')),
      numId: wAttr(child(numPr, 'numId'), 'val'),
      ilvl: num(wAttr(child(numPr, 'ilvl'), 'val')) ?? 0,
    });
    if (type === 'paragraph' && (wAttr(s, 'default') === '1' || wAttr(s, 'default') === 'true')) defaultParagraph = id;
  }

  // Resolve basedOn chains (with a guard against cycles in damaged files)
  const resolved = new Map<string, { run: Css; para: Css; contextual: boolean }>();
  const resolve = (id: string, depth = 0): { run: Css; para: Css; contextual: boolean } => {
    const hit = resolved.get(id);
    if (hit) return hit;
    const s = raw.get(id);
    if (!s || depth > 20) return { run: {}, para: {}, contextual: false };
    const parent = s.basedOn ? resolve(s.basedOn, depth + 1) : { run: {}, para: {}, contextual: false };
    const pPr = child(s.el, 'pPr');
    const ctx = onOff(child(pPr, 'contextualSpacing'));
    const out = {
      run: { ...parent.run, ...rPrCss(child(s.el, 'rPr'), theme) },
      para: { ...parent.para, ...pPrCss(pPr) },
      contextual: ctx ?? parent.contextual,
    };
    resolved.set(id, out);
    return out;
  };

  for (const [id, s] of raw) {
    const r = resolve(id);
    if (s.type === 'paragraph') {
      const selector = `.wd-doc .wd-p[data-style="${sel(id)}"]` + (id === defaultParagraph ? ',.wd-doc .wd-p:not([data-style])' : '');
      rules.push(`${selector}{${cssText({ ...r.run, ...r.para })}}`);
      if (r.contextual) {
        const p = `.wd-doc .wd-p[data-style="${sel(id)}"]`;
        rules.push(`${p}:has(+ ${p}){padding-bottom:0}${p} + ${p}{padding-top:0}`);
      }
    } else if (s.type === 'character') {
      rules.push(`.wd-doc [data-rstyle="${sel(id)}"]{${cssText(r.run)}}`);
    } else if (s.type === 'table') {
      const borders = child(child(s.el, 'tblPr'), 'tblBorders');
      if (borders && kids(borders).some((b) => !['nil', 'none'].includes(wAttr(b, 'val') || ''))) {
        rules.push(`.wd-doc table[data-style="${sel(id)}"] td{border:1px solid #000}`);
      }
    }
  }

  const paragraphStyles = [...byId.values()].filter((s) => s.type === 'paragraph');
  return { css: rules.join('\n'), byId, paragraphStyles, defaultParagraph };
}

/** "heading 1" -> "Heading 1" (Word stores built-in names in lower case). */
function displayStyleName(name: string): string {
  return name.replace(/^./, (c) => c.toUpperCase());
}

/** Follow basedOn until a style sets numbering. */
export function styleNumbering(styles: WordStyles, styleId: string | null): { numId: string; ilvl: number } | null {
  for (let id = styleId, depth = 0; id && depth < 20; depth++) {
    const s = styles.byId.get(id);
    if (!s) return null;
    if (s.numId) return { numId: s.numId, ilvl: s.ilvl };
    id = s.basedOn;
  }
  return null;
}

// ================= Numbering =================

export interface LevelDef {
  start: number;
  fmt: string;
  text: string;
  indL: number | null;
  hanging: number | null;
  font: string | null;
}

export interface Numbering {
  level(numId: string, ilvl: number): LevelDef | null;
  /** Explicit start value from a w:num override (restarts the list) */
  startOverride(numId: string, ilvl: number): number | null;
}

/** List kinds the editor can create in any document; real ids are assigned on export. */
export const APP_LISTS = {
  'app-bullet': { fmt: 'bullet', texts: ['•', '◦', '▪', '•', '◦', '▪', '•', '◦', '▪'] },
  'app-decimal': { fmt: 'decimal', texts: ['%1.', '%2.', '%3.', '%4.', '%5.', '%6.', '%7.', '%8.', '%9.'] },
} as const;
export type AppListId = keyof typeof APP_LISTS;

const appLevel = (id: AppListId, ilvl: number): LevelDef => {
  const def = APP_LISTS[id];
  const fmts = ['decimal', 'lowerLetter', 'lowerRoman'];
  return {
    start: 1,
    fmt: def.fmt === 'bullet' ? 'bullet' : fmts[ilvl % 3],
    text: def.texts[ilvl],
    indL: 720 * (ilvl + 1),
    hanging: 360,
    font: null,
  };
};

export function parseNumbering(xml: string | null): Numbering {
  const abstract = new Map<string, Map<number, LevelDef>>();
  const nums = new Map<string, { abstractId: string; overrides: Map<number, number> }>();
  if (xml) {
    const root = parseXml(xml).documentElement;
    for (const a of kids(root)) {
      if (a.localName === 'abstractNum') {
        const levels = new Map<number, LevelDef>();
        for (const l of kids(a).filter((k) => k.localName === 'lvl')) {
          const ind = child(child(l, 'pPr'), 'ind');
          levels.set(num(wAttr(l, 'ilvl')) ?? 0, {
            start: num(wAttr(child(l, 'start'), 'val')) ?? 1,
            fmt: wAttr(child(l, 'numFmt'), 'val') || 'decimal',
            text: wAttr(child(l, 'lvlText'), 'val') ?? '',
            indL: num(wAttr(ind, 'left') ?? wAttr(ind, 'start')),
            hanging: num(wAttr(ind, 'hanging')),
            font: wAttr(child(child(l, 'rPr'), 'rFonts'), 'ascii'),
          });
        }
        abstract.set(wAttr(a, 'abstractNumId') || '', levels);
      } else if (a.localName === 'num') {
        const overrides = new Map<number, number>();
        for (const o of kids(a).filter((k) => k.localName === 'lvlOverride')) {
          const start = num(wAttr(child(o, 'startOverride'), 'val'));
          if (start !== null) overrides.set(num(wAttr(o, 'ilvl')) ?? 0, start);
        }
        nums.set(wAttr(a, 'numId') || '', { abstractId: wAttr(child(a, 'abstractNumId'), 'val') || '', overrides });
      }
    }
  }
  return {
    level(numId, ilvl) {
      if (numId in APP_LISTS) return appLevel(numId as AppListId, ilvl);
      const n = nums.get(numId);
      return n ? abstract.get(n.abstractId)?.get(ilvl) ?? null : null;
    },
    startOverride(numId, ilvl) {
      return nums.get(numId)?.overrides.get(ilvl) ?? null;
    },
  };
}

const ROMAN: [number, string][] = [
  [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
  [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
];

export function formatNumber(n: number, fmt: string): string {
  switch (fmt) {
    case 'none':
      return '';
    case 'decimalZero':
      return n < 10 ? `0${n}` : String(n);
    case 'lowerLetter':
    case 'upperLetter': {
      // Word repeats the letter: a..z, aa..zz
      const letter = String.fromCharCode(97 + ((n - 1) % 26)).repeat(Math.floor((n - 1) / 26) + 1);
      return fmt === 'upperLetter' ? letter.toUpperCase() : letter;
    }
    case 'lowerRoman':
    case 'upperRoman': {
      let out = '';
      let v = n;
      for (const [value, sym] of ROMAN) while (v >= value) (out += sym), (v -= value);
      return fmt === 'upperRoman' ? out.toUpperCase() : out;
    }
    default:
      return String(n);
  }
}

/** Symbol / Wingdings private-use bullets -> Unicode look-alikes. */
const SYMBOL_BULLETS: Record<number, string> = {
  0xf0b7: '•', 0xf0a7: '▪', 0xf0a8: '□', 0xf0d8: '➢', 0xf0fc: '✓', 0xf076: '❖', 0xf06e: '■', 0xf06f: '□', 0xf0e8: '➔', 0xf02d: '-',
};

export function bulletText(text: string): string {
  if (!text) return '•';
  const code = text.charCodeAt(0);
  if (code >= 0xf000 && code <= 0xf0ff) return SYMBOL_BULLETS[code] ?? '•';
  return text;
}
