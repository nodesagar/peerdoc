import { describe, it, expect, vi } from 'vitest';
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
  it('falls back to the relay when direct peers lack the PDF too', async () => {
    // Laptop B has two tabs open on the link: they see each other over a direct
    // (same-browser) link, but only laptop A, reachable via relay, has the PDF.
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] });
    try {
      const pdf = new Uint8Array(40 * 1024).map((_, i) => i % 251);
      const documentId = await computeSHA256(pdf);
      const relay = memoryBroker();
      const local = memoryBroker();
      const got: (Uint8Array | null)[] = [null, null];
      const engines = [
        new DocSyncEngine({
          doc: new Y.Doc(), documentId, getLocalPdfBytes: () => pdf,
          transports: [new PubSubTransport('relay', relay, true)],
        }),
        ...[0, 1].map((i) => new DocSyncEngine({
          doc: new Y.Doc(), documentId, getLocalPdfBytes: () => got[i],
          transports: [new PubSubTransport('local', local), new PubSubTransport('relay', relay, true)],
          onPdfAvailable: (bytes) => (got[i] = bytes),
        })),
      ];
      for (let t = 0; t < 120 && !(got[0] && got[1]); t++) await vi.advanceTimersByTimeAsync(100);
      expect(got[0]?.byteLength).toBe(pdf.byteLength);
      expect(got[1]?.byteLength).toBe(pdf.byteLength);
      engines.forEach((e) => e.destroy());
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports request status: refusals, acceptance and verified receipt', async () => {
    const pdf = new Uint8Array(40 * 1024).map((_, i) => (i * 3) % 251);
    const documentId = await computeSHA256(pdf);
    const bus = memoryBroker();
    const events: string[] = [];
    const host = new DocSyncEngine({
      doc: new Y.Doc(), documentId, getLocalPdfBytes: () => pdf,
      transports: [new PubSubTransport('relay', bus, true)],
    });
    const otherJoiner = new DocSyncEngine({
      doc: new Y.Doc(), documentId, getLocalPdfBytes: () => null,
      transports: [new PubSubTransport('relay', bus, true)],
    });
    const me = new DocSyncEngine({
      doc: new Y.Doc(), documentId, getLocalPdfBytes: () => null,
      transports: [new PubSubTransport('relay', bus, true)],
      onPdfTransferEvent: (e) => events.push(e.kind),
    });
    await new Promise((r) => setTimeout(r, 50));
    me.requestPDFFromPeers(true, true);
    await new Promise((r) => setTimeout(r, 300));

    expect(events[0]).toBe('requested');
    expect(events).toContain('unavailable'); // otherJoiner has no copy
    expect(events).toContain('offered'); // host accepted
    expect(events.at(-1)).toBe('received');
    [host, otherJoiner, me].forEach((e) => e.destroy());
  });

  it('completes over a lossy relay by re-requesting only missing chunks', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] });
    try {
      const pdf = new Uint8Array(300 * 1024).map((_, i) => (i * 13) % 251); // 10 chunks
      const documentId = await computeSHA256(pdf);
      // Public brokers silently drop under load: lose every 3rd chunk message
      const base = memoryBroker();
      let dropped = 0;
      let chunkMsgs = 0;
      const lossy: PubSubBusFactory = (room, onMessage, selfId) => {
        const bus = base(room, onMessage, selfId);
        return {
          post: (m) => {
            if (m?.message?.type === 'pdf-chunk' && ++chunkMsgs % 3 === 0) return void dropped++;
            bus.post(m);
          },
          close: bus.close,
        };
      };
      const sentChunks: number[] = [];
      const host = new DocSyncEngine({
        doc: new Y.Doc(), documentId, getLocalPdfBytes: () => pdf,
        transports: [new PubSubTransport('relay', lossy, true)],
        onPdfTransferEvent: (e) => e.kind === 'serving' && sentChunks.push(e.totalChunks),
      });
      let got: Uint8Array | null = null;
      const joiner = new DocSyncEngine({
        doc: new Y.Doc(), documentId, getLocalPdfBytes: () => got,
        transports: [new PubSubTransport('relay', lossy, true)],
        onPdfAvailable: (b) => (got = b),
      });
      for (let t = 0; t < 600 && !got; t++) await vi.advanceTimersByTimeAsync(100);

      expect((got as Uint8Array | null)?.byteLength).toBe(pdf.byteLength);
      expect(dropped).toBeGreaterThan(0);
      expect(sentChunks[0]).toBe(10); // first stream: everything
      expect(sentChunks.slice(1).every((n) => n < 10)).toBe(true); // retries: only the gaps
      [host, joiner].forEach((e) => e.destroy());
    } finally {
      vi.useRealTimers();
    }
  });
});
