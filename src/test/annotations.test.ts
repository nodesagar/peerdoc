import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName } from 'pdf-lib';
import {
  addAnnotationCRDT,
  addCommentCRDT,
  removeAnnotationCRDT,
  updateAnnotationCRDT,
  readDocumentSnapshot,
  initializeDocument,
  createUndoManager,
} from '../lib/crdt/schema';
import { buildConvergedPDF } from '../utils/pdfProcessor';

const sync = (a: Y.Doc, b: Y.Doc) => {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
};

describe('annotations and comment threads', () => {
  it('concurrent replies converge to the same thread order on both peers', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const id = addAnnotationCRDT(a, { type: 'highlight', pageIndex: 0, x: 10, y: 10, width: 30, height: 4, color: '#f9ab00' });
    sync(a, b);
    // Offline: both reply at the same millisecond
    addCommentCRDT(a, { annotationId: id, text: 'from A', createdBy: 'A', createdAt: 5 });
    addCommentCRDT(b, { annotationId: id, text: 'from B', createdBy: 'B', createdAt: 5 });
    sync(a, b);
    const ta = readDocumentSnapshot(a).comments.map((c) => c.text);
    expect(ta).toHaveLength(2);
    expect(readDocumentSnapshot(b).comments.map((c) => c.text)).toEqual(ta);
  });

  it('resolving syncs; deleting removes the thread; undo restores both', () => {
    const doc = new Y.Doc();
    initializeDocument(doc, 'e'.repeat(64), 'x.pdf', 1);
    const um = createUndoManager(doc);
    const id = addAnnotationCRDT(doc, { type: 'note', pageIndex: 0, x: 50, y: 50, width: 0, height: 0, color: '#1a73e8' });
    addCommentCRDT(doc, { annotationId: id, text: 'Check clause 4' });
    updateAnnotationCRDT(doc, id, { resolved: true });
    expect(readDocumentSnapshot(doc).annotations[0].resolved).toBe(true);
    um.stopCapturing();

    removeAnnotationCRDT(doc, id);
    expect(readDocumentSnapshot(doc).annotations).toHaveLength(0);
    expect(readDocumentSnapshot(doc).comments).toHaveLength(0);

    um.undo();
    expect(readDocumentSnapshot(doc).annotations).toHaveLength(1);
    expect(readDocumentSnapshot(doc).comments[0].text).toBe('Check clause 4');
  });

  it('exports open threads as PDF sticky notes and skips resolved ones', async () => {
    const src = await PDFDocument.create();
    src.addPage([600, 800]);
    const bytes = await src.save();

    const doc = new Y.Doc();
    const open = addAnnotationCRDT(doc, { type: 'highlight', pageIndex: 0, x: 10, y: 10, width: 20, height: 5, color: '#f9ab00' });
    addCommentCRDT(doc, { annotationId: open, text: 'Löschen? ✓', createdBy: 'Ana' });
    const done = addAnnotationCRDT(doc, { type: 'box', pageIndex: 0, x: 50, y: 50, width: 10, height: 10, color: '#d93025', resolved: true });
    addCommentCRDT(doc, { annotationId: done, text: 'fixed' });
    addAnnotationCRDT(doc, { type: 'ink', pageIndex: 0, x: 0, y: 0, width: 0, height: 0, color: '#188038', points: [10, 10, 20, 20, 30, 10] });

    const out = await PDFDocument.load(await buildConvergedPDF(bytes, readDocumentSnapshot(doc)));
    const annots = out.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
    expect(annots.size()).toBe(1);
    const note = annots.lookup(0, PDFDict);
    expect(note.get(PDFName.of('Subtype'))).toBe(PDFName.of('Text'));
    expect((note.get(PDFName.of('Contents')) as PDFHexString).decodeText()).toBe('Ana: Löschen? ✓');
  });
});
