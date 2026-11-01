import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import {
  buildFrames,
  FrameCollector,
  FrameAddResult,
  computeDocStateHash,
} from '../lib/crdt/qrSync';
import {
  initializeDocument,
  addTextOverlayCRDT,
  addWhiteoutCRDT,
  addSignatureCRDT,
  rotatePageCRDT,
  readDocumentSnapshot,
} from '../lib/crdt/schema';

const DOC_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const OTHER_DOC_ID = 'ffffffff00000000111111112222222233333333444444445555555566666666';

describe('QR Sync (offline animated-QR CRDT transport)', () => {
  it('round-trips multi-frame updates when frames are shuffled and duplicated', async () => {
    const sourceDoc = new Y.Doc();
    initializeDocument(sourceDoc, DOC_ID, 'Offline_Report.pdf', 4);

    // Add enough content to span multiple ~500-char frames
    for (let i = 0; i < 20; i++) {
      addTextOverlayCRDT(sourceDoc, {
        pageIndex: i % 4,
        x: 10 + i,
        y: 15 + i,
        text: `Offline field note #${i} — Recorded without internet connectivity (${crypto.randomUUID()})`,
        fontSize: 12,
        fontFamily: 'Helvetica',
        color: '#1a1c1c',
      });
    }

    const originalUpdate = Y.encodeStateAsUpdate(sourceDoc);
    const frames = await buildFrames(sourceDoc, DOC_ID);
    expect(frames.length).toBeGreaterThan(1);

    // Verify frame header format: CD1|<docIdShort>|<sessionId>|<index>|<total>|<chunk>
    for (let i = 0; i < frames.length; i++) {
      const parts = frames[i].split('|');
      expect(parts).toHaveLength(6);
      expect(parts[0]).toBe('CD1');
      expect(parts[1]).toBe(DOC_ID.slice(0, 8));
      expect(parts[2]).toMatch(/^[0-9a-f]{6}$/);
      expect(Number(parts[3])).toBe(i);
      expect(Number(parts[4])).toBe(frames.length);
    }

    // Duplicate and shuffle frames
    const noisyStream = [...frames, ...frames.slice(0, 2), frames[frames.length - 1]]
      .map((f, idx) => ({ f, sortKey: (idx * 73) % 19 }))
      .sort((a, b) => a.sortKey - b.sortKey)
      .map((item) => item.f);

    const collector = new FrameCollector(DOC_ID);
    let lastResult: FrameAddResult = { progress: 0, received: 0, total: 0, complete: false };
    for (const frame of noisyStream) {
      lastResult = collector.add(frame);
      expect(lastResult.error).toBeUndefined();
    }

    expect(lastResult.complete).toBe(true);
    expect(lastResult.progress).toBe(1);

    const decodedUpdate = await collector.finish();
    expect(decodedUpdate).toEqual(originalUpdate);

    const targetDoc = new Y.Doc();
    Y.applyUpdate(targetDoc, decodedUpdate, 'qr');
    expect(readDocumentSnapshot(targetDoc)).toEqual(readDocumentSnapshot(sourceDoc));
  });

  it('syncs two Y.Docs with different offline edits both ways and converges to identical JSON & state hash', async () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    initializeDocument(docA, DOC_ID, 'Field_Agreement.pdf', 3);
    initializeDocument(docB, DOC_ID, 'Field_Agreement.pdf', 3);

    // Device A makes offline edits in airplane mode
    addTextOverlayCRDT(docA, {
      pageIndex: 0,
      x: 20,
      y: 30,
      text: 'Approved by Alice (Offline)',
      fontSize: 14,
    });
    rotatePageCRDT(docA, 'page-1', 90);

    // Device B makes different offline edits in airplane mode
    addWhiteoutCRDT(docB, {
      pageIndex: 1,
      x: 15,
      y: 25,
      width: 40,
      height: 10,
      color: '#ffffff',
    });
    addSignatureCRDT(docB, {
      pageIndex: 2,
      x: 50,
      y: 75,
      width: 25,
      height: 10,
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    });

    // Round 1: Device A sends QR frames -> Device B scans and merges
    const framesFromA = await buildFrames(docA, DOC_ID);
    const collectorB = new FrameCollector(DOC_ID);
    for (const frame of framesFromA) {
      const res = collectorB.add(frame);
      expect(res.error).toBeUndefined();
    }
    expect(collectorB.isComplete).toBe(true);
    const updateFromA = await collectorB.finish();
    Y.applyUpdate(docB, updateFromA, 'qr');

    // Swap roles (Round 2): Device B sends QR frames -> Device A scans and merges
    const framesFromB = await buildFrames(docB, DOC_ID);
    const collectorA = new FrameCollector(DOC_ID);
    for (const frame of framesFromB) {
      const res = collectorA.add(frame);
      expect(res.error).toBeUndefined();
    }
    expect(collectorA.isComplete).toBe(true);
    const updateFromB = await collectorA.finish();
    Y.applyUpdate(docA, updateFromB, 'qr');

    // Both documents must have identical JSON snapshots and state hashes
    expect(readDocumentSnapshot(docA)).toEqual(readDocumentSnapshot(docB));
    const hashA = await computeDocStateHash(docA);
    const hashB = await computeDocStateHash(docB);
    expect(hashA).toBe(hashB);
  });

  it('rejects wrong documentId, leaves missing frames incomplete, and fails checksum on corrupted chunk', async () => {
    const doc = new Y.Doc();
    initializeDocument(doc, DOC_ID, 'Test.pdf', 2);
    for (let i = 0; i < 12; i++) {
      addTextOverlayCRDT(doc, {
        pageIndex: 0,
        x: i * 5,
        y: i * 5,
        text: `Line item ${i} with unique content ${crypto.randomUUID()}`,
        fontSize: 12,
      });
    }

    const frames = await buildFrames(doc, DOC_ID);
    expect(frames.length).toBeGreaterThanOrEqual(2);

    // 1. Wrong documentId is rejected
    const wrongDocCollector = new FrameCollector(OTHER_DOC_ID);
    const wrongRes = wrongDocCollector.add(frames[0]);
    expect(wrongRes.complete).toBe(false);
    expect(wrongRes.received).toBe(0);
    expect(wrongRes.error).toMatch(/Document ID mismatch/i);

    // 2. Different sessionId is rejected mid-session
    const sessionCollector = new FrameCollector(DOC_ID);
    expect(sessionCollector.add(frames[0]).error).toBeUndefined();
    const forgedSessionFrame = frames[1].replace(
      /^CD1\|([0-9a-f]{8})\|[0-9a-f]{6}\|/,
      'CD1|$1|ffffff|'
    );
    const diffSessionRes = sessionCollector.add(forgedSessionFrame);
    expect(diffSessionRes.error).toMatch(/Different session ID/i);

    // 3. Missing frame leaves collector incomplete and finish() throws
    const incompleteCollector = new FrameCollector(DOC_ID);
    for (let i = 0; i < frames.length - 1; i++) {
      const res = incompleteCollector.add(frames[i]);
      expect(res.complete).toBe(false);
    }
    expect(incompleteCollector.isComplete).toBe(false);
    expect(incompleteCollector.progress).toBeCloseTo((frames.length - 1) / frames.length);
    await expect(incompleteCollector.finish()).rejects.toThrow(/incomplete/i);

    // 4. Corrupted chunk fails the SHA-256 sessionId checksum in finish()
    const corruptedCollector = new FrameCollector(DOC_ID);
    for (let i = 0; i < frames.length - 1; i++) {
      corruptedCollector.add(frames[i]);
    }
    const lastParts = frames[frames.length - 1].split('|');
    const origChunk = lastParts[5];
    const flippedChar = origChunk[0] === 'A' ? 'B' : 'A';
    lastParts[5] = flippedChar + origChunk.slice(1);
    const resCorrupt = corruptedCollector.add(lastParts.join('|'));
    expect(resCorrupt.complete).toBe(true);
    await expect(corruptedCollector.finish()).rejects.toThrow(/Checksum mismatch/i);
  });
});
