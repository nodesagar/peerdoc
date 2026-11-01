import { EditorState, Plugin, PluginKey, Command, TextSelection, Transaction } from 'prosemirror-state';
import { EditorView, Decoration, DecorationSet, NodeView } from 'prosemirror-view';
import { Node as PMNode, MarkType, Attrs } from 'prosemirror-model';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap, splitBlockAs, chainCommands } from 'prosemirror-commands';
import { dropCursor } from 'prosemirror-dropcursor';
import { gapCursor } from 'prosemirror-gapcursor';
import { columnResizing, tableEditing, goToNextCell, TableView, isInTable } from 'prosemirror-tables';
import { ySyncPlugin, yCursorPlugin } from 'y-prosemirror';
import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { wordSchema } from './schema';
import { WordPackage } from './package';
import { styleNumbering, formatNumber, bulletText, AppListId } from './styles';
import { twipsToPx, snippetName } from './xml';

/**
 * ProseMirror wiring for a Word part: Yjs binding, live collaborator cursors,
 * Word list numbering, picture resizing and Word-like keyboard behaviour.
 */

const S = wordSchema;
const { paragraph, image, hard_break, tab } = S.nodes;

// ================= List numbering =================

const listKey = new PluginKey<DecorationSet>('word-lists');

function listDecorations(doc: PMNode, pkg: WordPackage): DecorationSet {
  const counters = new Map<string, number[]>();
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type !== paragraph) return true;
    let numId: string | null = node.attrs.numId;
    let ilvl: number = node.attrs.ilvl ?? 0;
    if (numId == null) {
      const fromStyle = styleNumbering(pkg.styles, node.attrs.style ?? pkg.styles.defaultParagraph);
      if (fromStyle) ({ numId, ilvl } = fromStyle);
    }
    if (!numId || numId === '0') return false;
    const lvl = pkg.numbering.level(numId, ilvl);
    if (!lvl) return false;

    const c = counters.get(numId) ?? [];
    c[ilvl] = c[ilvl] === undefined ? (pkg.numbering.startOverride(numId, ilvl) ?? lvl.start) : c[ilvl] + 1;
    c.length = ilvl + 1; // a higher level restarts the levels below it
    counters.set(numId, c);
    const text =
      lvl.fmt === 'bullet'
        ? bulletText(lvl.text)
        : lvl.text.replace(/%(\d)/g, (_, d) => {
            const k = Number(d) - 1;
            const l = pkg.numbering.level(numId!, k);
            return formatNumber(c[k] ?? l?.start ?? 1, l?.fmt ?? 'decimal');
          });

    const hanging = twipsToPx(lvl.hanging ?? 360);
    const marker = document.createElement('span');
    marker.className = 'wd-marker';
    marker.contentEditable = 'false';
    marker.textContent = text;
    marker.style.minWidth = `${hanging}px`;
    if (lvl.font && !/symbol|wingdings/i.test(lvl.font)) marker.style.fontFamily = lvl.font;
    decos.push(Decoration.widget(pos + 1, marker, { side: -1, key: `m:${text}:${hanging}`, ignoreSelection: true }));

    // Numbering indents apply unless the paragraph sets its own
    if (node.attrs.indL == null && node.attrs.indFirst == null) {
      decos.push(
        Decoration.node(pos, pos + node.nodeSize, {
          style: `padding-left:${twipsToPx(lvl.indL ?? 720)}px;text-indent:${-hanging}px`,
        })
      );
    }
    return false;
  });
  return DecorationSet.create(doc, decos);
}

const listPlugin = (pkg: WordPackage) =>
  new Plugin<DecorationSet>({
    key: listKey,
    state: {
      init: (_, state) => listDecorations(state.doc, pkg),
      apply: (tr, old) => (tr.docChanged ? listDecorations(tr.doc, pkg) : old),
    },
    props: { decorations: (state) => listKey.getState(state) },
  });

// ================= Node views =================

/** Pictures from the package (by relationship) or embedded data URLs, with a resize handle. */
class ImageView implements NodeView {
  dom: HTMLElement;
  private img: HTMLImageElement;
  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
    private resolve: (rId: string) => string | null
  ) {
    this.dom = document.createElement('span');
    this.dom.className = 'wd-img';
    this.img = document.createElement('img');
    this.img.draggable = false;
    const handle = document.createElement('span');
    handle.className = 'wd-img-handle';
    handle.addEventListener('pointerdown', this.startResize);
    this.dom.append(this.img, handle);
    this.render();
  }
  private render() {
    const a = this.node.attrs;
    const src = a.src || (a.rId ? this.resolve(a.rId) : null);
    if (src) this.img.src = src;
    else this.img.removeAttribute('src');
    this.dom.classList.toggle('wd-img-missing', !src);
    this.dom.title = src ? a.alt || '' : 'Picture in a format browsers cannot show (kept in the file)';
    this.img.alt = a.alt || '';
    this.img.style.width = `${a.width}px`;
    this.img.style.height = `${a.height}px`;
  }
  private startResize = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const { width, height } = this.node.attrs;
    const ratio = height / width || 1;
    const zoom = this.view.dom.getBoundingClientRect().width / (this.view.dom as HTMLElement).offsetWidth || 1;
    let w = width;
    const move = (ev: PointerEvent) => {
      w = Math.max(16, Math.round(width + (ev.clientX - startX) / zoom));
      this.img.style.width = `${w}px`;
      this.img.style.height = `${Math.round(w * ratio)}px`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const pos = this.getPos();
      if (pos === undefined || w === width) return;
      this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, width: w, height: Math.round(w * ratio) }));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  update(node: PMNode) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }
  selectNode() {
    this.dom.classList.add('ProseMirror-selectednode');
  }
  deselectNode() {
    this.dom.classList.remove('ProseMirror-selectednode');
  }
  stopEvent(e: Event) {
    return (e.target as HTMLElement).classList?.contains('wd-img-handle');
  }
  ignoreMutation() {
    return true;
  }
}

/** Word table classes (borders, table style) on prosemirror-tables' resizable view. */
class WordTableView extends TableView {
  constructor(node: PMNode, cellMinWidth: number) {
    super(node, cellMinWidth);
    this.decorate(node);
  }
  update(node: PMNode) {
    const ok = super.update(node);
    if (ok) this.decorate(node);
    return ok;
  }
  private decorate(node: PMNode) {
    this.table.className = `wd-table${node.attrs.bordered ? ' wd-bordered' : ''}`;
    if (node.attrs.style) this.table.dataset.style = node.attrs.style;
    else delete this.table.dataset.style;
    const { offset, center } = tablePlacement(node.attrs.tblPrX);
    this.table.style.marginLeft = center ? 'auto' : offset ? `${offset}px` : '';
    this.table.style.marginRight = center ? 'auto' : '';
  }
}

/** Horizontal placement from w:tblPr: floating offset (tblpX), else indent (tblInd), or centred. */
export function tablePlacement(tblPr: string): { offset: number; center: boolean } {
  if (!tblPr) return { offset: 0, center: false };
  const attr = (el: string, name: string) => {
    const tag = new RegExp(`<w:${el}\\b[^>]*>`).exec(tblPr)?.[0];
    const v = tag && new RegExp(`w:${name}="(-?[\\d.]+)"`).exec(tag)?.[1];
    return v ? Number(v) : null;
  };
  if (/<w:jc w:val="center"/.test(tblPr)) return { offset: 0, center: true };
  const twips = /<w:tblpPr\b/.test(tblPr) && !/w:horzAnchor="page"/.test(tblPr) ? (attr('tblpPr', 'tblpX') ?? 0) : (attr('tblInd', 'w') ?? 0);
  return { offset: twipsToPx(twips), center: false };
}

// ================= Commands =================

/** Paragraphs touched by the selection (including the one holding the cursor). */
export function selectedParagraphs(state: EditorState): { node: PMNode; pos: number }[] {
  const { from, to, $from } = state.selection;
  const out: { node: PMNode; pos: number }[] = [];
  state.doc.nodesBetween(from, Math.max(to, from + 1), (node, pos) => {
    if (node.type === paragraph) {
      out.push({ node, pos });
      return false;
    }
    return true;
  });
  if (!out.length && $from.parent.type === paragraph) out.push({ node: $from.parent, pos: $from.before() });
  return out;
}

export const setParagraphAttrs =
  (patch: Attrs | ((node: PMNode) => Attrs)): Command =>
  (state, dispatch) => {
    const paras = selectedParagraphs(state);
    if (!paras.length) return false;
    if (dispatch) {
      const tr = state.tr;
      for (const { node, pos } of paras) tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...(typeof patch === 'function' ? patch(node) : patch) });
      dispatch(tr.scrollIntoView());
    }
    return true;
  };

/** Set (attrs) or clear (null) a mark over the selection, or for the next typed text. */
export const setMark =
  (type: MarkType, attrs: Attrs | null): Command =>
  (state, dispatch) => {
    const { empty, $cursor, ranges } = state.selection as TextSelection;
    if (!dispatch) return true;
    const tr = state.tr;
    if (empty && $cursor) {
      tr.removeStoredMark(type);
      if (attrs) tr.addStoredMark(type.create(attrs));
    } else {
      for (const { $from, $to } of ranges) {
        tr.removeMark($from.pos, $to.pos, type);
        if (attrs) tr.addMark($from.pos, $to.pos, type.create(attrs));
      }
    }
    dispatch(tr.scrollIntoView());
    return true;
  };

export function markActive(state: EditorState, type: MarkType): PMNode['marks'][number] | null {
  const { from, to, empty, $from } = state.selection;
  if (empty) return type.isInSet(state.storedMarks || $from.marks()) ?? null;
  let found: PMNode['marks'][number] | null = null;
  state.doc.nodesBetween(from, to, (node) => {
    if (!found && node.isInline) found = type.isInSet(node.marks) ?? null;
  });
  return found;
}

export const toggleListCommand =
  (kind: AppListId, pkg: WordPackage): Command =>
  (state, dispatch) => {
    const paras = selectedParagraphs(state);
    const all = paras.length > 0 && paras.every(({ node }) => node.attrs.numId === kind);
    return setParagraphAttrs((node) => {
      if (!all) return { numId: kind, ilvl: node.attrs.numId ? node.attrs.ilvl : 0 };
      // Turning a list off: '0' also cancels numbering a paragraph style would add
      return { numId: styleNumbering(pkg.styles, node.attrs.style) ? '0' : null, ilvl: 0 };
    })(state, dispatch);
  };

export const indentCommand =
  (delta: 1 | -1): Command =>
  (state, dispatch) =>
    setParagraphAttrs((node) =>
      node.attrs.numId && node.attrs.numId !== '0'
        ? { ilvl: Math.min(8, Math.max(0, (node.attrs.ilvl ?? 0) + delta)) }
        : { indL: Math.max(0, (node.attrs.indL ?? 0) + 720 * delta) || null }
    )(state, dispatch);

const insertNode =
  (make: () => PMNode): Command =>
  (state, dispatch) => {
    dispatch?.(state.tr.replaceSelectionWith(make(), true).scrollIntoView());
    return true;
  };

export const insertPageBreak = insertNode(() => hard_break.create({ type: 'page' }));

export function insertTableCommand(rows: number, cols: number, contentWidth: number): Command {
  const width = Math.floor(contentWidth / cols);
  return (state, dispatch) => {
    const cell = () => S.nodes.table_cell.create({ colwidth: [width] }, paragraph.create());
    const table = S.nodes.table.create(
      { style: 'TableGrid', bordered: true },
      Array.from({ length: rows }, () => S.nodes.table_row.create(null, Array.from({ length: cols }, cell)))
    );
    if (!dispatch) return true;
    const tr = state.tr.replaceSelectionWith(table);
    // Caret into the first cell (replaceSelectionWith leaves it after the table)
    let tablePos = -1;
    tr.doc.descendants((n, pos) => {
      if (n === table) tablePos = pos;
      return tablePos < 0;
    });
    if (tablePos >= 0) tr.setSelection(TextSelection.near(tr.doc.resolve(tablePos + 1)));
    dispatch(tr.scrollIntoView());
    return true;
  };
}

export function insertImageCommand(src: string, naturalW: number, naturalH: number, maxWidth: number): Command {
  const scale = Math.min(1, maxWidth / naturalW);
  return insertNode(() => image.create({ src, width: Math.round(naturalW * scale), height: Math.round(naturalH * scale) }));
}

/** Enter: Word semantics for styles (Heading -> its "next" style), lists and section breaks. */
function splitParagraph(pkg: WordPackage): Command {
  return (state, dispatch) => {
    const { $from, empty } = state.selection;
    const para = $from.parent;
    if (para.type !== paragraph) return false;
    if (empty && para.content.size === 0 && para.attrs.numId && para.attrs.numId !== '0') {
      dispatch?.(state.tr.setNodeMarkup($from.before(), undefined, { ...para.attrs, numId: null, ilvl: 0 }));
      return true;
    }
    const marks = state.storedMarks || $from.marks();
    return splitBlockAs((node, atEnd) => {
      let pPrX = node.attrs.pPrX as string;
      try {
        // a section break stays with the paragraph that had it
        pPrX = pPrX ? JSON.stringify((JSON.parse(pPrX) as string[]).filter((x) => snippetName(x) !== 'sectPr')) : '';
      } catch {
        pPrX = '';
      }
      const attrs: Record<string, any> = { ...node.attrs, pPrX };
      if (atEnd) {
        const next = node.attrs.style ? pkg.styles.byId.get(node.attrs.style)?.next : null;
        if (next && next !== node.attrs.style) attrs.style = next === pkg.styles.defaultParagraph ? null : next;
      }
      return { type: paragraph, attrs };
    })(state, (tr: Transaction) => dispatch?.(tr.ensureMarks(marks).scrollIntoView()));
  };
}

const listBackspace: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  const para = $from.parent;
  if (!empty || $from.parentOffset !== 0 || para.type !== paragraph || !para.attrs.numId || para.attrs.numId === '0') return false;
  dispatch?.(state.tr.setNodeMarkup($from.before(), undefined, { ...para.attrs, numId: null, ilvl: 0 }));
  return true;
};

const inList = (state: EditorState) => {
  const p = state.selection.$from.parent;
  return p.type === paragraph && p.attrs.numId && p.attrs.numId !== '0';
};

// ================= Editor =================

export interface WordEditorOptions {
  mount: HTMLElement;
  fragment: Y.XmlFragment;
  pkg: WordPackage;
  part: string;
  /** Collaborator cursors: only one editor per room may publish its selection */
  awareness?: Awareness | null;
  undo: () => void;
  redo: () => void;
  onUpdate: (view: EditorView) => void;
  onFocus: (view: EditorView) => void;
  onImageFile: (view: EditorView, file: File) => void;
  editable?: () => boolean;
}

export function createWordEditor(o: WordEditorOptions): EditorView {
  const keys = keymap({
    'Mod-z': () => (o.undo(), true),
    'Shift-Mod-z': () => (o.redo(), true),
    'Mod-y': () => (o.redo(), true),
    Enter: splitParagraph(o.pkg),
    'Shift-Enter': insertNode(() => hard_break.create()),
    'Mod-Enter': insertPageBreak,
    Tab: chainCommands(goToNextCell(1), (s, d) => (inList(s) ? indentCommand(1)(s, d) : false), insertNode(() => tab.create())),
    'Shift-Tab': chainCommands(goToNextCell(-1), (s, d) => (inList(s) ? indentCommand(-1)(s, d) : false)),
    Backspace: listBackspace,
    'Mod-l': setParagraphAttrs({ align: null }),
    'Mod-e': setParagraphAttrs({ align: 'center' }),
    'Mod-r': setParagraphAttrs({ align: 'right' }),
    'Mod-j': setParagraphAttrs({ align: 'justify' }),
    'Mod-Alt-0': setParagraphAttrs({ style: null }),
    'Mod-Alt-1': setParagraphAttrs({ style: 'Heading1' }),
    'Mod-Alt-2': setParagraphAttrs({ style: 'Heading2' }),
    'Mod-Alt-3': setParagraphAttrs({ style: 'Heading3' }),
  });

  const plugins: Plugin[] = [
    ySyncPlugin(o.fragment),
    ...(o.awareness
      ? [
          yCursorPlugin(o.awareness, {
            // PDF rooms reuse 'cursor' for page pointers; only text selections belong here
            awarenessStateFilter: (current: number, client: number, state: any) => current !== client && !!state?.cursor?.anchor,
          }),
        ]
      : []),
    keys,
    keymap(baseKeymap),
    listPlugin(o.pkg),
    columnResizing({ View: WordTableView as any, cellMinWidth: 24 }),
    tableEditing(),
    dropCursor({ color: '#0087ff' }),
    gapCursor(),
  ];

  const pickImage = (files: FileList | undefined | null) => {
    const file = files && Array.from(files).find((f) => f.type.startsWith('image/'));
    if (!file) return false;
    o.onImageFile(view, file);
    return true;
  };

  const view: EditorView = new EditorView(o.mount, {
    state: EditorState.create({ schema: S, plugins }),
    editable: o.editable,
    attributes: { class: 'wd-doc', spellcheck: 'true' },
    nodeViews: {
      image: (node, v, getPos) => new ImageView(node, v, getPos, (rId) => o.pkg.mediaUrl(o.part, rId)),
      raw_inline: (node) => {
        const dom = document.createElement('span');
        const src = node.attrs.rId ? o.pkg.mediaUrl(o.part, node.attrs.rId) : null;
        if (src) {
          const img = document.createElement('img');
          img.src = src;
          img.className = 'wd-raw-img';
          dom.append(img);
        } else {
          dom.className = node.attrs.label ? 'wd-raw' : 'wd-raw wd-raw-hidden';
          dom.textContent = node.attrs.label || '';
        }
        if (node.attrs.label) dom.title = node.attrs.label;
        return { dom, ignoreMutation: () => true };
      },
    },
    handlePaste: (_v, e) => pickImage(e.clipboardData?.files),
    handleDrop: (_v, e) => pickImage((e as DragEvent).dataTransfer?.files),
    handleDOMEvents: { focus: (v) => (o.onFocus(v), false) },
    // `this`, not `view`: y-prosemirror dispatches while the EditorView constructor is still running
    dispatchTransaction(this: EditorView, tr) {
      this.updateState(this.state.apply(tr));
      o.onUpdate(this);
    },
  });
  return view;
}

export { isInTable };
