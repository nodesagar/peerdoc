import * as Y from 'yjs';
import { ySyncPluginKey } from 'y-prosemirror';
import { generateFractionalIndex, generateInitialIndices } from './fractionalIndex';
import { Annotation, ThreadComment, Attribution, PageMetadata, TextOverlay, WhiteoutBox, RedactionBox, SignatureBox } from '../../types';
import type { TextEdit } from '../pdf/textEdit';

export interface DocumentSnapshot {
  meta: {
    documentId: string;
    title: string;
    createdAt: number;
    /** 'word' for Word documents; absent (PDF) for rooms created before formats existed */
    format?: string;
  };
  pages: PageMetadata[];
  textOverlays: TextOverlay[];
  whiteouts: WhiteoutBox[];
  redactions: RedactionBox[];
  signatures: SignatureBox[];
  annotations: Annotation[];
  comments: ThreadComment[];
  /** In-place edits of the PDF's own text (absent in snapshots built by older code) */
  textEdits?: TextEdit[];
}

export function getMetaMap(doc: Y.Doc): Y.Map<any> {
  return doc.getMap('meta');
}

export function getPagesMap(doc: Y.Doc): Y.Map<Y.Map<any>> {
  return doc.getMap('pages');
}

export function getTextOverlaysMap(doc: Y.Doc): Y.Map<Y.Map<any>> {
  return doc.getMap('textOverlays');
}

export function getWhiteoutsMap(doc: Y.Doc): Y.Map<Y.Map<any>> {
  return doc.getMap('whiteouts');
}

export function getRedactionsMap(doc: Y.Doc): Y.Map<Y.Map<any>> {
  return doc.getMap('redactions');
}

export function getSignaturesMap(doc: Y.Doc): Y.Map<Y.Map<any>> {
  return doc.getMap('signatures');
}

export function getAnnotationsMap(doc: Y.Doc): Y.Map<Y.Map<any>> {
  return doc.getMap('annotations');
}

export function getCommentsMap(doc: Y.Doc): Y.Map<Y.Map<any>> {
  return doc.getMap('comments');
}

export function getTextEditsMap(doc: Y.Doc): Y.Map<Y.Map<any>> {
  return doc.getMap('textEdits');
}

/** Body of a Word document (y-prosemirror fragment). Headers/footers use `word:<part path>`. */
export const WORD_BODY = 'word:body';

/**
 * Undo/redo for this user's edits only. Local mutations use origin null (the
 * UndoManager default) and Word editor edits come from y-prosemirror
 * (ySyncPluginKey); peer updates ('p2p'), IndexedDB loads, .cdsync imports
 * ('file-sync') and seeding (SEED_ORIGIN) carry other origins and are skipped.
 */
export function createUndoManager(doc: Y.Doc): Y.UndoManager {
  return new Y.UndoManager(
    [
      getPagesMap(doc),
      getTextOverlaysMap(doc),
      getWhiteoutsMap(doc),
      getRedactionsMap(doc),
      getSignaturesMap(doc),
      getAnnotationsMap(doc),
      getCommentsMap(doc),
      getTextEditsMap(doc),
      doc.getXmlFragment(WORD_BODY),
    ],
    { trackedOrigins: new Set([null, ySyncPluginKey]) }
  );
}

/** FNV-1a 32-bit; stable non-zero Yjs client ID derived from the document ID. */
export function seedClientId(documentId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < documentId.length; i++) {
    h ^= documentId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0 || 1;
}

/**
 * Byte-identical initial page structure for a given (documentId, pageCount).
 * Every peer that seeds the same PDF independently produces the SAME Yjs structs
 * (same client ID + clocks), so merging them is a no-op instead of one peer's
 * page maps (and every rotation/move nested in them) overwriting the other's.
 */
function buildSeedUpdate(documentId: string, pageCount: number): Uint8Array {
  const seed = new Y.Doc();
  seed.clientID = seedClientId(documentId);
  seed.transact(() => {
    getMetaMap(seed).set('documentId', documentId);
    const pages = getPagesMap(seed);
    const initialOrders = generateInitialIndices(pageCount);
    for (let i = 0; i < pageCount; i++) {
      const pageId = `page-${i}`;
      const pageMap = new Y.Map<any>();
      pageMap.set('id', pageId);
      pageMap.set('originalIndex', i);
      pageMap.set('order', initialOrders[i]);
      pageMap.set('rotation', 0);
      pageMap.set('deleted', false);
      pages.set(pageId, pageMap);
    }
  });
  const update = Y.encodeStateAsUpdate(seed);
  seed.destroy();
  return update;
}

/** Origin of document setup; the undo manager only tracks user edits (origin null). */
export const SEED_ORIGIN = 'seed';

/**
 * Initialize document metadata and pages if doc is newly created.
 */
export function initializeDocument(
  doc: Y.Doc,
  documentId: string,
  title: string,
  pageCount: number
) {
  if (getPagesMap(doc).size === 0 && pageCount > 0) {
    Y.applyUpdate(doc, buildSeedUpdate(documentId, pageCount), SEED_ORIGIN);
  }
  // Peer-specific values stay outside the seed; concurrent sets are plain last-writer-wins.
  doc.transact(() => {
    const meta = getMetaMap(doc);
    if (!meta.has('documentId')) meta.set('documentId', documentId);
    if (!meta.has('title')) meta.set('title', title);
    if (!meta.has('createdAt')) meta.set('createdAt', Date.now());
  }, SEED_ORIGIN);
}

/**
 * Seed a Word document from its deterministic import (see word/seed.ts). Peers
 * that import the same file independently produce identical structs, so the
 * seeds merge as a no-op instead of duplicating the text.
 */
export function initializeWordDocument(doc: Y.Doc, title: string, seedUpdate: Uint8Array) {
  if (doc.getXmlFragment(WORD_BODY).length === 0) Y.applyUpdate(doc, seedUpdate, SEED_ORIGIN);
  doc.transact(() => {
    const meta = getMetaMap(doc);
    if (!meta.has('title')) meta.set('title', title);
    if (!meta.has('createdAt')) meta.set('createdAt', Date.now());
  }, SEED_ORIGIN);
}

/**
 * Read the current reactive or static snapshot of the document.
 */
export function readDocumentSnapshot(doc: Y.Doc): DocumentSnapshot {
  const metaMap = getMetaMap(doc);
  const meta = {
    documentId: (metaMap.get('documentId') as string) || '',
    title: (metaMap.get('title') as string) || 'Untitled Document',
    createdAt: (metaMap.get('createdAt') as number) || 0,
    ...(typeof metaMap.get('format') === 'string' ? { format: metaMap.get('format') as string } : {}),
  };

  // 1. Pages (sorted by order, filter deleted if needed for viewing)
  const pagesMap = getPagesMap(doc);
  const rawPages: PageMetadata[] = [];
  pagesMap.forEach((pageYMap, pageId) => {
    rawPages.push({
      id: (pageYMap.get('id') as string) || pageId,
      originalIndex: (pageYMap.get('originalIndex') as number) ?? 0,
      order: (pageYMap.get('order') as string) || 'm',
      rotation: (pageYMap.get('rotation') as number) || 0,
      deleted: Boolean(pageYMap.get('deleted')),
    });
  });
  // Sort deterministically by fractional index. Concurrent moves can yield equal
  // keys, and Y.Map iteration order differs per peer, so tie-break on id.
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  rawPages.sort((a, b) => cmp(a.order, b.order) || cmp(a.id, b.id));

  // 2. Text Overlays (nested maps with Y.Text)
  const overlaysMap = getTextOverlaysMap(doc);
  const textOverlays: TextOverlay[] = [];
  overlaysMap.forEach((overlayMap, id) => {
    const textObj = overlayMap.get('text');
    let textStr = '';
    if (textObj instanceof Y.Text) {
      textStr = textObj.toString();
    } else if (typeof textObj === 'string') {
      textStr = textObj;
    }

    textOverlays.push({
      id: (overlayMap.get('id') as string) || id,
      pageIndex: (overlayMap.get('pageIndex') as number) ?? 0,
      x: (overlayMap.get('x') as number) ?? 0,
      y: (overlayMap.get('y') as number) ?? 0,
      text: textStr,
      fontSize: (overlayMap.get('fontSize') as number) ?? 14,
      color: overlayMap.get('color') as string,
      fontFamily: overlayMap.get('fontFamily') as any,
      isBold: Boolean(overlayMap.get('isBold')),
      isItalic: Boolean(overlayMap.get('isItalic')),
      ...readAttribution(overlayMap),
    });
  });

  // 3. Whiteout boxes
  const whiteoutsMap = getWhiteoutsMap(doc);
  const whiteouts: WhiteoutBox[] = [];
  whiteoutsMap.forEach((wMap, id) => {
    whiteouts.push({
      id: (wMap.get('id') as string) || id,
      pageIndex: (wMap.get('pageIndex') as number) ?? 0,
      x: (wMap.get('x') as number) ?? 0,
      y: (wMap.get('y') as number) ?? 0,
      width: (wMap.get('width') as number) ?? 10,
      height: (wMap.get('height') as number) ?? 5,
      color: (wMap.get('color') as string) || '#ffffff',
      ...readAttribution(wMap),
    });
  });

  // 4. Redaction boxes
  const redactionsMap = getRedactionsMap(doc);
  const redactions: RedactionBox[] = [];
  redactionsMap.forEach((rMap, id) => {
    redactions.push({
      id: (rMap.get('id') as string) || id,
      pageIndex: (rMap.get('pageIndex') as number) ?? 0,
      x: (rMap.get('x') as number) ?? 0,
      y: (rMap.get('y') as number) ?? 0,
      width: (rMap.get('width') as number) ?? 10,
      height: (rMap.get('height') as number) ?? 5,
      label: rMap.get('label') as string,
      ...readAttribution(rMap),
    });
  });

  // 5. Signatures
  const signaturesMap = getSignaturesMap(doc);
  const signatures: SignatureBox[] = [];
  signaturesMap.forEach((sMap, id) => {
    signatures.push({
      id: (sMap.get('id') as string) || id,
      pageIndex: (sMap.get('pageIndex') as number) ?? 0,
      x: (sMap.get('x') as number) ?? 0,
      y: (sMap.get('y') as number) ?? 0,
      width: (sMap.get('width') as number) ?? 20,
      height: (sMap.get('height') as number) ?? 10,
      dataUrl: (sMap.get('dataUrl') as string) || '',
      ...readAttribution(sMap),
    });
  });

  // 6. Annotations and their comment threads
  const annotations: Annotation[] = [];
  getAnnotationsMap(doc).forEach((aMap, id) => {
    const points = aMap.get('points');
    annotations.push({
      id: (aMap.get('id') as string) || id,
      type: (aMap.get('type') as Annotation['type']) || 'note',
      pageIndex: (aMap.get('pageIndex') as number) ?? 0,
      x: (aMap.get('x') as number) ?? 0,
      y: (aMap.get('y') as number) ?? 0,
      width: (aMap.get('width') as number) ?? 0,
      height: (aMap.get('height') as number) ?? 0,
      color: (aMap.get('color') as string) || '#f9ab00',
      ...(Array.isArray(points) ? { points: points as number[] } : {}),
      resolved: Boolean(aMap.get('resolved')),
      ...readAttribution(aMap),
    });
  });

  const comments: ThreadComment[] = [];
  getCommentsMap(doc).forEach((cMap, id) => {
    comments.push({
      id: (cMap.get('id') as string) || id,
      annotationId: (cMap.get('annotationId') as string) || '',
      text: (cMap.get('text') as string) || '',
      ...readAttribution(cMap),
    });
  });
  // Thread order: oldest first; id breaks ties identically on every peer
  comments.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const TEXT_EDIT_NUMBERS = ['pageIndex', 'x0', 'x1', 'baseline', 'size', 'originX', 'styleX', 'styleY'] as const;
  const textEdits: TextEdit[] = [];
  getTextEditsMap(doc).forEach((m, id) => {
    const e = { id: (m.get('id') as string) || id, original: String(m.get('original') ?? ''), text: String(m.get('text') ?? ''), ...readAttribution(m) } as TextEdit;
    for (const k of TEXT_EDIT_NUMBERS) (e as any)[k] = Number(m.get(k) ?? 0);
    textEdits.push(e);
  });
  // Same application order on every peer
  textEdits.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    meta,
    pages: rawPages,
    textOverlays,
    whiteouts,
    redactions,
    signatures,
    annotations,
    comments,
    textEdits,
  };
}

function writeAttribution(map: Y.Map<any>, item: Attribution) {
  if (item.createdBy) map.set('createdBy', item.createdBy);
  if (item.createdByColor) map.set('createdByColor', item.createdByColor);
  if (item.createdAt) map.set('createdAt', item.createdAt);
}

function readAttribution(map: Y.Map<any>): Attribution {
  const out: Attribution = {};
  if (typeof map.get('createdBy') === 'string') out.createdBy = map.get('createdBy');
  if (typeof map.get('createdByColor') === 'string') out.createdByColor = map.get('createdByColor');
  if (typeof map.get('createdAt') === 'number') out.createdAt = map.get('createdAt');
  return out;
}

// ================= Mutations helpers with nested Y.Maps =================

export function addTextOverlayCRDT(
  doc: Y.Doc,
  overlay: Omit<TextOverlay, 'id'> & { id?: string }
): string {
  const id = overlay.id || crypto.randomUUID();
  doc.transact(() => {
    const overlays = getTextOverlaysMap(doc);
    const map = new Y.Map<any>();
    map.set('id', id);
    map.set('pageIndex', overlay.pageIndex);
    map.set('x', overlay.x);
    map.set('y', overlay.y);
    map.set('fontSize', overlay.fontSize);
    if (overlay.color) map.set('color', overlay.color);
    if (overlay.fontFamily) map.set('fontFamily', overlay.fontFamily);
    map.set('isBold', Boolean(overlay.isBold));
    map.set('isItalic', Boolean(overlay.isItalic));

    const yText = new Y.Text();
    yText.insert(0, overlay.text || '');
    map.set('text', yText);

    writeAttribution(map, overlay);
    overlays.set(id, map);
  });
  return id;
}

export function updateTextOverlayCRDT(
  doc: Y.Doc,
  id: string,
  patch: Partial<TextOverlay>
) {
  doc.transact(() => {
    const overlays = getTextOverlaysMap(doc);
    const map = overlays.get(id);
    if (!map) return;

    if (patch.x !== undefined) map.set('x', patch.x);
    if (patch.y !== undefined) map.set('y', patch.y);
    if (patch.fontSize !== undefined) map.set('fontSize', patch.fontSize);
    if (patch.color !== undefined) map.set('color', patch.color);
    if (patch.fontFamily !== undefined) map.set('fontFamily', patch.fontFamily);
    if (patch.isBold !== undefined) map.set('isBold', patch.isBold);
    if (patch.isItalic !== undefined) map.set('isItalic', patch.isItalic);
    if (patch.pageIndex !== undefined) map.set('pageIndex', patch.pageIndex);

    if (patch.text !== undefined) {
      const existingText = map.get('text');
      if (existingText instanceof Y.Text) {
        // Apply only the changed span; delete-all + insert-all duplicates text
        // when two peers type into the same overlay concurrently.
        const oldStr = existingText.toString();
        const newStr = patch.text;
        if (oldStr !== newStr) {
          let start = 0;
          while (start < oldStr.length && start < newStr.length && oldStr[start] === newStr[start]) start++;
          let end = 0;
          while (
            end < oldStr.length - start &&
            end < newStr.length - start &&
            oldStr[oldStr.length - 1 - end] === newStr[newStr.length - 1 - end]
          ) end++;
          const delLen = oldStr.length - start - end;
          if (delLen > 0) existingText.delete(start, delLen);
          const ins = newStr.slice(start, newStr.length - end);
          if (ins) existingText.insert(start, ins);
        }
      } else {
        const yText = new Y.Text();
        yText.insert(0, patch.text);
        map.set('text', yText);
      }
    }
  });
}

export function removeTextOverlayCRDT(doc: Y.Doc, id: string) {
  doc.transact(() => {
    const overlays = getTextOverlaysMap(doc);
    overlays.delete(id);
  });
}

export function addWhiteoutCRDT(
  doc: Y.Doc,
  box: Omit<WhiteoutBox, 'id'> & { id?: string }
): string {
  const id = box.id || crypto.randomUUID();
  doc.transact(() => {
    const whiteouts = getWhiteoutsMap(doc);
    const map = new Y.Map<any>();
    map.set('id', id);
    map.set('pageIndex', box.pageIndex);
    map.set('x', box.x);
    map.set('y', box.y);
    map.set('width', box.width);
    map.set('height', box.height);
    map.set('color', box.color || '#ffffff');
    writeAttribution(map, box);
    whiteouts.set(id, map);
  });
  return id;
}

export function updateWhiteoutCRDT(
  doc: Y.Doc,
  id: string,
  patch: Partial<WhiteoutBox>
) {
  doc.transact(() => {
    const whiteouts = getWhiteoutsMap(doc);
    const map = whiteouts.get(id);
    if (!map) return;

    if (patch.x !== undefined) map.set('x', patch.x);
    if (patch.y !== undefined) map.set('y', patch.y);
    if (patch.width !== undefined) map.set('width', patch.width);
    if (patch.height !== undefined) map.set('height', patch.height);
    if (patch.color !== undefined) map.set('color', patch.color);
    if (patch.pageIndex !== undefined) map.set('pageIndex', patch.pageIndex);
  });
}

export function removeWhiteoutCRDT(doc: Y.Doc, id: string) {
  doc.transact(() => {
    const whiteouts = getWhiteoutsMap(doc);
    whiteouts.delete(id);
  });
}

export function addRedactionCRDT(
  doc: Y.Doc,
  redaction: Omit<RedactionBox, 'id'> & { id?: string }
): string {
  const id = redaction.id || crypto.randomUUID();
  doc.transact(() => {
    const redactions = getRedactionsMap(doc);
    const map = new Y.Map<any>();
    map.set('id', id);
    map.set('pageIndex', redaction.pageIndex);
    map.set('x', redaction.x);
    map.set('y', redaction.y);
    map.set('width', redaction.width);
    map.set('height', redaction.height);
    if (redaction.label) map.set('label', redaction.label);
    writeAttribution(map, redaction);
    redactions.set(id, map);
  });
  return id;
}

export function removeRedactionCRDT(doc: Y.Doc, id: string) {
  doc.transact(() => {
    const redactions = getRedactionsMap(doc);
    redactions.delete(id);
  });
}

export function addSignatureCRDT(
  doc: Y.Doc,
  sig: Omit<SignatureBox, 'id'> & { id?: string }
): string {
  const id = sig.id || crypto.randomUUID();
  doc.transact(() => {
    const signatures = getSignaturesMap(doc);
    const map = new Y.Map<any>();
    map.set('id', id);
    map.set('pageIndex', sig.pageIndex);
    map.set('x', sig.x);
    map.set('y', sig.y);
    map.set('width', sig.width);
    map.set('height', sig.height);
    map.set('dataUrl', sig.dataUrl);
    writeAttribution(map, sig);
    signatures.set(id, map);
  });
  return id;
}

export function updateSignatureCRDT(
  doc: Y.Doc,
  id: string,
  patch: Partial<SignatureBox>
) {
  doc.transact(() => {
    const signatures = getSignaturesMap(doc);
    const map = signatures.get(id);
    if (!map) return;

    if (patch.x !== undefined) map.set('x', patch.x);
    if (patch.y !== undefined) map.set('y', patch.y);
    if (patch.width !== undefined) map.set('width', patch.width);
    if (patch.height !== undefined) map.set('height', patch.height);
    if (patch.pageIndex !== undefined) map.set('pageIndex', patch.pageIndex);
  });
}

export function removeSignatureCRDT(doc: Y.Doc, id: string) {
  doc.transact(() => {
    const signatures = getSignaturesMap(doc);
    signatures.delete(id);
  });
}

/**
 * Reorder a page to a new index between target neighbors using fractional index.
 */
export function movePageCRDT(
  doc: Y.Doc,
  pageId: string,
  prevOrder: string | null,
  nextOrder: string | null
) {
  doc.transact(() => {
    const pages = getPagesMap(doc);
    const pageMap = pages.get(pageId);
    if (!pageMap) return;

    const newOrder = generateFractionalIndex(prevOrder, nextOrder);
    pageMap.set('order', newOrder);
  });
}

export function rotatePageCRDT(
  doc: Y.Doc,
  pageId: string,
  degreesDelta: number
) {
  doc.transact(() => {
    const pages = getPagesMap(doc);
    const pageMap = pages.get(pageId);
    if (!pageMap) return;

    const currentRotation = (pageMap.get('rotation') as number) || 0;
    const newRotation = (currentRotation + degreesDelta + 360) % 360;
    pageMap.set('rotation', newRotation);
  });
}

export function setPageDeletedCRDT(
  doc: Y.Doc,
  pageId: string,
  deleted: boolean
) {
  doc.transact(() => {
    const pages = getPagesMap(doc);
    const pageMap = pages.get(pageId);
    if (!pageMap) return;

    pageMap.set('deleted', deleted);
  });
}

// ================= Annotations & comment threads =================

export function addAnnotationCRDT(doc: Y.Doc, a: Omit<Annotation, 'id'> & { id?: string }): string {
  const id = a.id || crypto.randomUUID();
  doc.transact(() => {
    const map = new Y.Map<any>();
    map.set('id', id);
    map.set('type', a.type);
    map.set('pageIndex', a.pageIndex);
    map.set('x', a.x);
    map.set('y', a.y);
    map.set('width', a.width);
    map.set('height', a.height);
    map.set('color', a.color);
    if (a.points) map.set('points', [...a.points]);
    map.set('resolved', Boolean(a.resolved));
    writeAttribution(map, a);
    getAnnotationsMap(doc).set(id, map);
  });
  return id;
}

export function updateAnnotationCRDT(
  doc: Y.Doc,
  id: string,
  patch: Partial<Pick<Annotation, 'x' | 'y' | 'width' | 'height' | 'color' | 'resolved'>>
) {
  doc.transact(() => {
    const map = getAnnotationsMap(doc).get(id);
    if (!map) return;
    for (const [key, value] of Object.entries(patch)) if (value !== undefined) map.set(key, value);
  });
}

/** Removes the annotation and its whole thread in one undoable step. */
export function removeAnnotationCRDT(doc: Y.Doc, id: string) {
  doc.transact(() => {
    getAnnotationsMap(doc).delete(id);
    const comments = getCommentsMap(doc);
    comments.forEach((c, cid) => {
      if (c.get('annotationId') === id) comments.delete(cid);
    });
  });
}

export function addCommentCRDT(doc: Y.Doc, c: Omit<ThreadComment, 'id'> & { id?: string }): string {
  const id = c.id || crypto.randomUUID();
  doc.transact(() => {
    const map = new Y.Map<any>();
    map.set('id', id);
    map.set('annotationId', c.annotationId);
    map.set('text', c.text);
    writeAttribution(map, c);
    getCommentsMap(doc).set(id, map);
  });
  return id;
}

export function removeCommentCRDT(doc: Y.Doc, id: string) {
  doc.transact(() => {
    getCommentsMap(doc).delete(id);
  });
}

// ================= In-place text edits =================

/** Create or replace the edit of one text run (fields are last-writer-wins). */
export function upsertTextEditCRDT(doc: Y.Doc, e: Omit<TextEdit, 'id'> & { id?: string }): string {
  const id = e.id || crypto.randomUUID();
  doc.transact(() => {
    const edits = getTextEditsMap(doc);
    let map = edits.get(id);
    if (!map) {
      map = new Y.Map<any>();
      map.set('id', id);
      writeAttribution(map, e);
      edits.set(id, map);
    }
    for (const k of ['pageIndex', 'x0', 'x1', 'baseline', 'size', 'originX', 'styleX', 'styleY', 'original', 'text'] as const) {
      if (map.get(k) !== e[k]) map.set(k, e[k]);
    }
  });
  return id;
}

export function removeTextEditCRDT(doc: Y.Doc, id: string) {
  doc.transact(() => {
    getTextEditsMap(doc).delete(id);
  });
}
