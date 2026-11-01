import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { zipSync } from 'fflate';
import { TextSelection } from 'prosemirror-state';
import { loadWordPackage } from '../lib/word/package';
import { buildWordSeed, fragmentFor } from '../lib/word/seed';
import { createDocxFiles } from '../lib/word/templates';
import { createWordEditor } from '../lib/word/editor';
import { wordSchema } from '../lib/word/schema';
import { formatShortcuts } from '../components/WordEditor';

/** A live body editor over a one-paragraph document, with the toolbar's shortcuts bound. */
function editorWith(text: string) {
  const pkg = loadWordPackage(zipSync(createDocxFiles(`<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`)));
  const doc = new Y.Doc();
  Y.applyUpdate(doc, buildWordSeed('shortcuts', pkg));
  let linkPrompts = 0;
  const view = createWordEditor({
    mount: document.body.appendChild(document.createElement('div')),
    fragment: doc.getXmlFragment(fragmentFor(pkg, pkg.main)),
    pkg,
    part: pkg.main,
    undo: () => {},
    redo: () => {},
    onUpdate: () => {},
    onFocus: () => {},
    onImageFile: () => {},
    shortcuts: formatShortcuts(pkg, () => linkPrompts++),
  });
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 1 + text.length)));
  // Mod is Ctrl off a Mac (happy-dom reports a non-Mac platform)
  const press = (key: string, extra: KeyboardEventInit = {}) =>
    view.dom.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true, ...extra }));
  return { view, press, links: () => linkPrompts };
}

const hasMark = (view: ReturnType<typeof editorWith>['view'], name: keyof typeof wordSchema.marks) =>
  view.state.doc.rangeHasMark(1, view.state.doc.content.size - 1, wordSchema.marks[name]);
const boldOn = (view: ReturnType<typeof editorWith>['view']) => {
  let on: boolean | undefined;
  view.state.doc.descendants((n) => {
    const b = wordSchema.marks.bold.isInSet(n.marks);
    if (n.isText && b) on = b.attrs.on !== false;
  });
  return on;
};

describe('Word keyboard shortcuts', () => {
  it('Ctrl+B toggles bold on, then off again', () => {
    const { view, press } = editorWith('Hello');
    press('b');
    expect(boldOn(view)).toBe(true);
    press('b');
    expect(boldOn(view)).toBe(false);
  });

  it('Ctrl+I, Ctrl+U and Ctrl+Shift+X apply italic, underline and strikethrough', () => {
    const { view, press } = editorWith('Hello');
    press('i');
    press('u');
    press('X', { shiftKey: true });
    expect(hasMark(view, 'italic')).toBe(true);
    expect(hasMark(view, 'underline')).toBe(true);
    expect(hasMark(view, 'strike')).toBe(true);
  });

  it('Ctrl+Shift+8 makes a bullet list, and Ctrl+K opens the link prompt', () => {
    const { view, press, links } = editorWith('Hello');
    press('*', { shiftKey: true, code: 'Digit8', keyCode: 56 } as KeyboardEventInit);
    expect(view.state.doc.firstChild?.attrs.numId).toBe('app-bullet');
    press('k');
    expect(links()).toBe(1);
  });
});
