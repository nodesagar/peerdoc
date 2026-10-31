import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { deriveRelayChannel, sealMessage, openMessage } from '../lib/crdt/relayTransport';
import { DocSyncEngine, PubSubTransport, PubSubBusFactory } from '../lib/crdt/docSync';
import { computeSHA256 } from '../lib/crdt/pdfStore';
import { addWhiteoutCRDT, readDocumentSnapshot } from '../lib/crdt/schema';

// In-memory stand-in for a broker topic; serialises like the network would
function memoryBroker(): PubSubBusFactory {
  const rooms = new Map<string, Set<(m: any) => void>>();
  return (roomId, onMessage) => {
    if (!rooms.has(roomId)) rooms.set(roomId, new Set());
    const subs = rooms.get(roomId)!;
    subs.add(onMessage);
    return {
      post: (msg) => {
        const wire = JSON.stringify(msg);
        subs.forEach((s) => setTimeout(() => s(JSON.parse(wire)), 0));
      },
      close: () => subs.delete(onMessage),
    };
  };
}

describe('Encrypted relay transport', () => {
  it('derives a hashed topic and only the same room can open messages', async () => {
    const a = await deriveRelayChannel('a'.repeat(64));
    const b = await deriveRelayChannel('b'.repeat(64));
    expect(a.topic).not.toContain('a'.repeat(64));
    const sealed = await sealMessage(a.key, { hello: 'world' });
    expect(new TextDecoder().decode(sealed)).not.toContain('world');
    expect(await openMessage((await deriveRelayChannel('a'.repeat(64))).key, sealed)).toEqual({ hello: 'world' });
    await expect(openMessage(b.key, sealed)).rejects.toThrow();
  });

  it('syncs edits and delivers the PDF when the relay is the only path', async () => {
    const pdf = new Uint8Array(70 * 1024).map((_, i) => (i * 7) % 256); // 3 chunks
    const documentId = await computeSHA256(pdf);
    const broker = memoryBroker();
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    let received: Uint8Array | null = null;

    const engineA = new DocSyncEngine({
      doc: docA, documentId, getLocalPdfBytes: () => pdf,
      transports: [new PubSubTransport('relay', broker, true)],
    });
    addWhiteoutCRDT(docA, { pageIndex: 0, x: 1, y: 1, width: 2, height: 2 });
    const engineB = new DocSyncEngine({
      doc: docB, documentId, getLocalPdfBytes: () => received,
      transports: [new PubSubTransport('relay', broker, true)],
      onPdfAvailable: (bytes) => (received = bytes),
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(engineB.getConnectedPeerCount()).toBe(1);
    expect(readDocumentSnapshot(docB).whiteouts.length).toBe(1);

    // No direct link: the manual request (and the poll after the grace period) uses the relay
    engineB.requestPDFFromPeers();
    await new Promise((r) => setTimeout(r, 400));
    const got = received as Uint8Array | null; // assigned in callback; TS can't see it
    expect(got?.byteLength).toBe(pdf.byteLength);
    expect(Array.from(got!.subarray(0, 8))).toEqual(Array.from(pdf.subarray(0, 8)));

    engineA.destroy();
    engineB.destroy();
  });
});
