import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import {
  createUndoManager,
  initializeDocument,
  readDocumentSnapshot,
  addTextOverlayCRDT,
  updateTextOverlayCRDT,
  addWhiteoutCRDT,
  rotatePageCRDT,
} from '../lib/crdt/schema';

const ID = 'b'.repeat(64);

function syncFrom(from: Y.Doc, to: Y.Doc) {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)), 'p2p');
}

describe('per-user undo', () => {
  it('never undoes document seeding', () => {
    const doc = new Y.Doc();
    const um = createUndoManager(doc);
    initializeDocument(doc, ID, 'a.pdf', 3);
    expect(um.canUndo()).toBe(false);
    um.undo();
    expect(readDocumentSnapshot(doc).pages).toHaveLength(3);
  });

  it('undoes and redoes only local edits, leaving peer edits intact', () => {
    const alice = new Y.Doc();
    const bob = new Y.Doc();
    initializeDocument(alice, ID, 'a.pdf', 2);
    syncFrom(alice, bob);
    const aliceUndo = createUndoManager(alice);

    const mine = addTextOverlayCRDT(alice, { pageIndex: 0, x: 10, y: 10, text: 'mine', fontSize: 12 });
    aliceUndo.stopCapturing();
    addWhiteoutCRDT(bob, { pageIndex: 1, x: 0, y: 0, width: 5, height: 5 });
    rotatePageCRDT(bob, 'page-0', 90);
    syncFrom(bob, alice);

    aliceUndo.undo();
    let snap = readDocumentSnapshot(alice);
    expect(snap.textOverlays.find((o) => o.id === mine)).toBeUndefined();
    expect(snap.whiteouts).toHaveLength(1);
    expect(snap.pages.find((p) => p.id === 'page-0')?.rotation).toBe(90);

    aliceUndo.redo();
    snap = readDocumentSnapshot(alice);
    expect(snap.textOverlays.find((o) => o.id === mine)?.text).toBe('mine');
  });

  it('undoes a text edit back to the previous text', () => {
    const doc = new Y.Doc();
    initializeDocument(doc, ID, 'a.pdf', 1);
    const id = addTextOverlayCRDT(doc, { pageIndex: 0, x: 0, y: 0, text: 'Hello', fontSize: 12 });
    const um = createUndoManager(doc);
    updateTextOverlayCRDT(doc, id, { text: 'Hello world' });
    um.undo();
    expect(readDocumentSnapshot(doc).textOverlays[0].text).toBe('Hello');
  });
});
