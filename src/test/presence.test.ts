import { describe, it, expect, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { DocSyncEngine, SyncTransport, PeerMessage } from '../lib/crdt/docSync';
import { remotePeers, timeAgo, initials } from '../lib/presence';
import { addTextOverlayCRDT, addWhiteoutCRDT, readDocumentSnapshot } from '../lib/crdt/schema';

/** In-memory mesh; messages are JSON round-tripped like Trystero does. */
class MemTransport implements SyncTransport {
  name = 'Mem';
  relay = false;
  sent: PeerMessage[] = [];
  static net = new Map<string, MemTransport>();
  private joins: ((id: string) => void)[] = [];
  private leaves: ((id: string) => void)[] = [];
  private msgs: ((id: string, m: PeerMessage) => void)[] = [];
  constructor(public id: string) {}
  connect() {
    const others = [...MemTransport.net];
    MemTransport.net.set(this.id, this); // reachable before anyone reacts to the join
    for (const [otherId, other] of others) {
      other.joins.forEach((cb) => cb(this.id));
      this.joins.forEach((cb) => cb(otherId));
    }
  }
  disconnect() {
    MemTransport.net.delete(this.id);
    for (const other of MemTransport.net.values()) other.leaves.forEach((cb) => cb(this.id));
  }
  sendToPeer(peerId: string, m: PeerMessage) {
    const copy = JSON.parse(JSON.stringify(m));
    MemTransport.net.get(peerId)?.msgs.forEach((cb) => cb(this.id, copy));
  }
  broadcast(m: PeerMessage) {
    this.sent.push(m);
    for (const id of MemTransport.net.keys()) if (id !== this.id) this.sendToPeer(id, m);
  }
  onPeerJoin(cb: (id: string) => void) { this.joins.push(cb); }
  onPeerLeave(cb: (id: string) => void) { this.leaves.push(cb); }
  onMessage(cb: (id: string, m: PeerMessage) => void) { this.msgs.push(cb); }
  getPeers() { return [...MemTransport.net.keys()].filter((id) => id !== this.id); }
}

function peer(id: string, name: string, relay = false) {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  awareness.setLocalState({ user: { name, color: '#188038' } });
  const transport = new MemTransport(id);
  transport.relay = relay;
  const engine = new DocSyncEngine({ doc, documentId: 'd'.repeat(64), awareness, transports: [transport], getLocalPdfBytes: () => new Uint8Array(1) });
  return { doc, awareness, transport, engine };
}

const names = (a: Awareness) => remotePeers(a).map((p) => p.user.name);

describe('presence', () => {
  it('peers see each other, follow cursor moves, and vanish on leave', () => {
    MemTransport.net.clear();
    const alice = peer('a', 'Alice');
    const bob = peer('b', 'Bob');
    expect(names(alice.awareness)).toEqual(['Bob']);
    expect(names(bob.awareness)).toEqual(['Alice']);

    alice.awareness.setLocalStateField('cursor', { pageIndex: 1, x: 40, y: 60 });
    expect(remotePeers(bob.awareness)[0].cursor).toEqual({ pageIndex: 1, x: 40, y: 60 });

    alice.transport.disconnect(); // tab closed: link drops without a goodbye
    expect(names(bob.awareness)).toEqual([]);
    alice.engine.destroy();
    bob.engine.destroy();
  });

  it('announces departure when the engine is destroyed', () => {
    MemTransport.net.clear();
    const alice = peer('a', 'Alice');
    const bob = peer('b', 'Bob');
    alice.engine.destroy();
    expect(names(bob.awareness)).toEqual([]);
    bob.engine.destroy();
  });

  it('coalesces presence over the relay so cursor streams cannot flood brokers', () => {
    vi.useFakeTimers();
    try {
      MemTransport.net.clear();
      const alice = peer('a', 'Alice', true);
      const bob = peer('b', 'Bob', true);
      alice.transport.sent.length = 0;
      for (let i = 0; i < 20; i++) alice.awareness.setLocalStateField('cursor', { pageIndex: 0, x: i, y: i });
      expect(alice.transport.sent.filter((m) => m.type === 'awareness')).toHaveLength(0);
      vi.advanceTimersByTime(450);
      expect(alice.transport.sent.filter((m) => m.type === 'awareness')).toHaveLength(1);
      expect(remotePeers(bob.awareness)[0].cursor).toEqual({ pageIndex: 0, x: 19, y: 19 });
      alice.engine.destroy(); // goodbye is flushed immediately, not after the interval
      expect(names(bob.awareness)).toEqual([]);
      bob.engine.destroy();
    } finally {
      vi.useRealTimers(); // even if an assertion fails, later tests get real timers
    }
  });

  it('formats names and times', () => {
    expect(initials('Teal Otter')).toBe('TO');
    expect(initials('  ')).toBe('?');
    expect(timeAgo(Date.now() - 120_000)).toMatch(/2 minutes ago/);
  });
});

describe('attribution', () => {
  it('stores who added an item and when, and syncs it', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    addTextOverlayCRDT(a, { pageIndex: 0, x: 1, y: 1, text: 'hi', fontSize: 12, createdBy: 'Alice', createdByColor: '#188038', createdAt: 1000 });
    addWhiteoutCRDT(a, { pageIndex: 0, x: 0, y: 0, width: 1, height: 1 });
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const snap = readDocumentSnapshot(b);
    expect(snap.textOverlays[0]).toMatchObject({ createdBy: 'Alice', createdByColor: '#188038', createdAt: 1000 });
    expect(snap.whiteouts[0].createdBy).toBeUndefined(); // older items simply lack it
  });
});
