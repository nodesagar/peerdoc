import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import {
  ChunkMessage,
  ChunkReassembler,
  chunkPDF,
  getOriginalPDF,
  storeOriginalPDF,
  hasOriginalPDF,
  uint8ArrayToBase64,
  normalizeToUint8Array,
} from './pdfStore';
import { roomChannel } from './roomKey';

export interface PeerMessage {
  type: 'state-vector' | 'state-update' | 'request-pdf' | 'pdf-chunk' | 'pdf-offer' | 'pdf-unavailable' | 'awareness'
    // Access control channel (access.ts)
    | 'roster' | 'join';
  payload: any;
  /** Sender's engine session ID; lets one remote tab reached over several transports count once. */
  sender?: string;
}

export interface SyncTransport {
  name: string;
  connect(roomId: string): void;
  disconnect(): void;
  sendToPeer(peerId: string, message: PeerMessage): void;
  broadcast(message: PeerMessage): void;
  onPeerJoin(cb: (peerId: string) => void): void;
  onPeerLeave(cb: (peerId: string) => void): void;
  onMessage(cb: (peerId: string, message: PeerMessage) => void): void;
  getPeers(): string[];
  /** Third-party relay (e.g. MQTT broker): use only when no direct link exists. */
  readonly relay?: boolean;
}

/** Human-visible progress of fetching (or serving) the original PDF. */
export type PdfTransferEvent =
  | { kind: 'requested'; routes: string[]; peers: number }
  | { kind: 'offered'; peer: string; route: string; totalChunks: number; bytes: number }
  | { kind: 'unavailable'; peer: string; route: string }
  | { kind: 'verify-failed'; reason: string }
  | { kind: 'received'; bytes: number }
  | { kind: 'serving'; peer: string; route: string; totalChunks: number; bytes: number }
  | { kind: 'served'; peer: string; route: string };

export interface DocSyncOptions {
  doc: Y.Doc;
  documentId: string;
  /** Secret from the share link; transports join roomChannel(documentId, roomKey). */
  roomKey?: string;
  /** Presence (cursors, names) shared with peers; never persisted. */
  awareness?: Awareness;
  transports: SyncTransport[];
  getLocalPdfBytes?: () => Uint8Array | null;
  onPeersChange?: (peersCount: number) => void;
  onPdfAvailable?: (bytes: Uint8Array, filename?: string) => void;
  onPdfProgress?: (progress: number) => void;
  onPdfTransferEvent?: (event: PdfTransferEvent) => void;
}

export const routeLabel = (t: SyncTransport) =>
  t.relay ? 'encrypted relay' : t.name === 'BroadcastChannel' ? 'same browser' : 'direct WebRTC';

/**
 * DocSyncEngine orchestrates CRDT state synchronization across transports.
 * Implements the mandatory state-vector handshake on peer join, automatic PDF
 * acquisition from peers, and live update relaying.
 */
export class DocSyncEngine {
  private doc: Y.Doc;
  public readonly documentId: string;
  private transports: SyncTransport[];
  private options: DocSyncOptions;
  // `${transport}:${peerId}` -> remote session ID (null until its handshake arrives)
  private activePeers: Map<string, string | null> = new Map();
  private readonly sessionId = crypto.randomUUID();
  private firstRelayLinkAt = 0;
  private static RELAY_GRACE_MS = 6000; // give WebRTC a chance before pulling the PDF via relay
  private pdfReassembler: ChunkReassembler | null = null;
  private destroyed = false;
  private pdfPollTimer: any = null;
  private pdfAcquired = false;
  private lastChunkAt = 0;
  private lastRequestLog = { key: '', at: 0 };
  private refusalLoggedAt = new Map<string, number>();
  private refusedLinks = new Set<string>(); // links that answered 'pdf-unavailable'
  private serving = new Set<string>(); // links we're currently streaming the PDF to
  private relaySendChain: Promise<unknown> = Promise.resolve(); // one relay upload at a time
  private static RELAY_CHUNK_GAP_MS = 120; // public brokers silently drop faster bursts
  // Awareness client -> links it was heard on; dropped when its last link leaves.
  private awarenessLinks = new Map<number, Set<string>>();
  private relayAwarenessTimer: ReturnType<typeof setTimeout> | null = null;
  private static RELAY_AWARENESS_INTERVAL_MS = 400;

  constructor(options: DocSyncOptions) {
    this.doc = options.doc;
    this.documentId = options.documentId.trim().toLowerCase();
    this.transports = options.transports;
    this.options = options;

    this.init();
  }

  private init() {
    // 1. Listen for local Y.Doc mutations and broadcast to peers
    this.doc.on('update', this.handleLocalDocUpdate);
    this.options.awareness?.on('update', this.handleAwarenessUpdate);

    // 2. Initialize all transports
    for (const transport of this.transports) {
      transport.onPeerJoin((peerId) => this.handlePeerJoin(transport, peerId));
      transport.onPeerLeave((peerId) => this.handlePeerLeave(transport, peerId));
      transport.onMessage((peerId, message) => this.handlePeerMessage(transport, peerId, message));
      transport.connect(this.options.roomKey ? roomChannel(this.documentId, this.options.roomKey) : this.documentId);
    }

    // 3. Start PDF polling to guarantee document retrieval when peers connect
    this.startPdfPolling();
  }

  private startPdfPolling() {
    this.stopPdfPolling();
    this.pdfPollTimer = setInterval(async () => {
      if (this.destroyed) {
        this.stopPdfPolling();
        return;
      }
      const hasLocal = Boolean(this.options.getLocalPdfBytes?.());
      if (hasLocal) {
        this.stopPdfPolling();
        return;
      }
      if (await hasOriginalPDF(this.documentId)) {
        // Another tab of this browser fetched and stored it: load it, don't just stop
        this.stopPdfPolling();
        const entry = await getOriginalPDF(this.documentId);
        if (entry && !this.pdfAcquired && !this.destroyed) {
          this.pdfAcquired = true;
          this.emit({ kind: 'received', bytes: entry.bytes.byteLength });
          this.options.onPdfAvailable?.(entry.bytes, entry.filename);
        }
        return;
      }
      // If we have connected peers and still lack PDF, request again
      // (but not while a transfer is actively streaming in - that restarts it).
      // After the grace period ask the relay too, even with direct links: those
      // peers (e.g. another tab of this browser) may not have the PDF either.
      if (this.activePeers.size > 0 && Date.now() - this.lastChunkAt > 5000) {
        const relayDue =
          this.firstRelayLinkAt > 0 &&
          (Date.now() - this.firstRelayLinkAt > DocSyncEngine.RELAY_GRACE_MS || this.allDirectLinksRefused());
        this.requestPDFFromPeers(relayDue);
      }
    }, 2500);
  }

  private stopPdfPolling() {
    if (this.pdfPollTimer) {
      clearInterval(this.pdfPollTimer);
      this.pdfPollTimer = null;
    }
  }

  private handleLocalDocUpdate = (update: Uint8Array, origin: any) => {
    if (this.destroyed) return;
    // Skip if incoming from remote peer (they already have it). File-sync imports
    // ARE forwarded so currently connected peers receive them too.
    if (origin === 'p2p') {
      return;
    }

    const message: PeerMessage = {
      type: 'state-update',
      payload: uint8ArrayToBase64(update),
    };

    for (const transport of this.transports) {
      transport.broadcast(message);
    }
  };

  private handleAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown
  ) => {
    const awareness = this.options.awareness!;
    if (typeof origin === 'string' && origin.startsWith('link:')) {
      // Remote change: remember which link carries each client; don't echo it back.
      const link = origin.slice(5);
      for (const id of [...added, ...updated]) {
        if (!this.awarenessLinks.has(id)) this.awarenessLinks.set(id, new Set());
        this.awarenessLinks.get(id)!.add(link);
      }
      removed.forEach((id) => this.awarenessLinks.delete(id));
      return;
    }
    removed.forEach((id) => this.awarenessLinks.delete(id)); // timeouts / leaves
    // Only our own state goes out (peer timeouts and leaves are local bookkeeping)
    if (![...added, ...updated, ...removed].includes(awareness.clientID)) return;
    const message = this.localAwarenessMessage();
    for (const transport of this.transports) if (!transport.relay) transport.broadcast(message);
    // Public brokers drop bursts (which could take CRDT updates with them), so the
    // relay gets at most one presence message per interval, carrying the latest state.
    if (!this.relayAwarenessTimer && this.transports.some((t) => t.relay)) {
      this.relayAwarenessTimer = setTimeout(() => {
        this.relayAwarenessTimer = null;
        const latest = this.localAwarenessMessage();
        for (const transport of this.transports) if (transport.relay) transport.broadcast(latest);
      }, DocSyncEngine.RELAY_AWARENESS_INTERVAL_MS);
    }
  };

  private localAwarenessMessage(): PeerMessage {
    const awareness = this.options.awareness!;
    return { type: 'awareness', payload: uint8ArrayToBase64(encodeAwarenessUpdate(awareness, [awareness.clientID])) };
  }

  /**
   * On EVERY peer join: Handshake step 1
   * Send local state vector to remote peer so they can send us whatever history we missed.
   * Also, if we don't have the original PDF yet, immediately request it from this peer!
   */
  private async handlePeerJoin(transport: SyncTransport, peerId: string) {
    if (this.destroyed) return;
    const key = `${transport.name}:${peerId}`;
    if (!this.activePeers.has(key)) this.activePeers.set(key, null);
    this.notifyPeers();

    // 1. Send our local state vector
    const localStateVector = Y.encodeStateVector(this.doc);
    transport.sendToPeer(peerId, {
      type: 'state-vector',
      payload: uint8ArrayToBase64(localStateVector),
      sender: this.sessionId,
    });

    // Presence: tell the newcomer who's here right now
    const awareness = this.options.awareness;
    if (awareness && awareness.getStates().size > 0) {
      transport.sendToPeer(peerId, {
        type: 'awareness',
        payload: uint8ArrayToBase64(encodeAwarenessUpdate(awareness, [...awareness.getStates().keys()])),
      });
    }

    // 2. Check if we need the PDF file from this newly joined peer.
    // Relay links never pull the PDF immediately; the poll falls back to them.
    if (transport.relay) {
      this.firstRelayLinkAt ||= Date.now();
      return;
    }
    const hasLocal = Boolean(this.options.getLocalPdfBytes?.());
    if (!hasLocal) {
      const existsInDb = await hasOriginalPDF(this.documentId);
      if (!existsInDb && !this.destroyed) {
        transport.sendToPeer(peerId, {
          type: 'request-pdf',
          payload: { documentId: this.documentId },
        });
      }
    }
  }

  private handlePeerLeave(transport: SyncTransport, peerId: string) {
    if (this.destroyed) return;
    const key = `${transport.name}:${peerId}`;
    this.activePeers.delete(key);
    this.notifyPeers();

    // Remove presence of clients no longer reachable over any link
    const gone: number[] = [];
    for (const [clientId, links] of this.awarenessLinks) {
      links.delete(key);
      if (links.size === 0) gone.push(clientId);
    }
    if (gone.length && this.options.awareness) removeAwarenessStates(this.options.awareness, gone, 'peer-left');
  }

  /**
   * Handle incoming messages from peers
   */
  private async handlePeerMessage(
    transport: SyncTransport,
    peerId: string,
    message: PeerMessage
  ) {
    if (this.destroyed || !message || !message.type) return;

    const key = `${transport.name}:${peerId}`;
    if (message.sender && this.activePeers.has(key) && this.activePeers.get(key) !== message.sender) {
      this.activePeers.set(key, message.sender);
      this.notifyPeers();
    }

    switch (message.type) {
      case 'state-vector': {
        // Peer sent their state vector -> Send them the delta diff
        const remoteVector = normalizeToUint8Array(message.payload);
        if (remoteVector.byteLength > 0) {
          const update = Y.encodeStateAsUpdate(this.doc, remoteVector);
          if (update.byteLength > 0) {
            transport.sendToPeer(peerId, {
              type: 'state-update',
              payload: uint8ArrayToBase64(update),
            });
          }
        } else {
          // If remote peer sent empty state vector, send full state
          const fullUpdate = Y.encodeStateAsUpdate(this.doc);
          if (fullUpdate.byteLength > 0) {
            transport.sendToPeer(peerId, {
              type: 'state-update',
              payload: uint8ArrayToBase64(fullUpdate),
            });
          }
        }
        break;
      }

      case 'awareness': {
        const update = normalizeToUint8Array(message.payload);
        if (update.byteLength > 0 && this.options.awareness) {
          applyAwarenessUpdate(this.options.awareness, update, `link:${key}`);
        }
        break;
      }

      case 'state-update': {
        // Apply remote update to our Y.Doc
        const update = normalizeToUint8Array(message.payload);
        if (update.byteLength > 0) {
          Y.applyUpdate(this.doc, update, 'p2p');
        }
        break;
      }

      case 'request-pdf': {
        // Peer requested original PDF bytes
        let bytes = this.options.getLocalPdfBytes?.() || null;
        let filename = 'Document.pdf';

        if (!bytes) {
          const pdfEntry = await getOriginalPDF(this.documentId);
          if (pdfEntry && pdfEntry.bytes) {
            bytes = pdfEntry.bytes;
            filename = pdfEntry.filename || filename;
          }
        }

        const peer = this.peerLabel(transport, peerId);
        const route = routeLabel(transport);
        if (!bytes || bytes.byteLength === 0) {
          // Tell the requester right away instead of leaving it waiting
          transport.sendToPeer(peerId, { type: 'pdf-unavailable', payload: {}, sender: this.sessionId });
          break;
        }
        const linkKey = `${transport.name}:${peerId}`;
        if (this.serving.has(linkKey)) break; // stream in progress; they'll ask for gaps after
        const chunks = chunkPDF(this.documentId, bytes, filename);
        // Re-requests list only the chunks that went missing
        const requested: unknown = message.payload?.missing;
        const indices =
          Array.isArray(requested) && requested.length > 0
            ? requested.filter((i): i is number => Number.isInteger(i) && i >= 0 && i < chunks.length)
            : chunks.map((_, i) => i);

        this.serving.add(linkKey); // at queue time, so re-requests don't queue duplicates
        const stream = async () => {
          transport.sendToPeer(peerId, {
            type: 'pdf-offer',
            payload: { totalChunks: chunks.length, sending: indices.length, bytes: bytes!.byteLength, filename },
            sender: this.sessionId,
          });
          this.emit({ kind: 'serving', peer, route, totalChunks: indices.length, bytes: bytes!.byteLength });
          try {
            for (let n = 0; n < indices.length; n++) {
              if (this.destroyed) break;
              transport.sendToPeer(peerId, { type: 'pdf-chunk', payload: chunks[indices[n]] });
              // Pacing: avoid flooding the DataChannel / tripping public broker rate limits
              if (transport.relay) {
                await new Promise((r) => setTimeout(r, DocSyncEngine.RELAY_CHUNK_GAP_MS));
              } else if (indices.length > 2 && n % 4 === 0) {
                await new Promise((r) => setTimeout(r, 6));
              }
            }
          } finally {
            this.serving.delete(linkKey);
            this.emit({ kind: 'served', peer, route });
          }
        };
        if (transport.relay) {
          this.relaySendChain = this.relaySendChain.then(stream, stream);
          await this.relaySendChain;
        } else {
          await stream();
        }
        break;
      }

      case 'pdf-offer': {
        if (this.pdfAcquired) break;
        const { totalChunks = 0, sending = totalChunks, bytes = 0 } = message.payload || {};
        this.lastChunkAt = Date.now(); // transfer accepted: don't re-request while it starts
        this.emit({
          kind: 'offered',
          peer: this.peerLabel(transport, peerId),
          route: routeLabel(transport),
          totalChunks: sending,
          bytes,
        });
        break;
      }

      case 'pdf-unavailable': {
        if (this.pdfAcquired) break;
        this.refusedLinks.add(key);
        const peer = this.peerLabel(transport, peerId);
        // Every poll re-asks; report each refusing peer at most every 30s
        if (Date.now() - (this.refusalLoggedAt.get(peer) ?? 0) > 30000) {
          this.refusalLoggedAt.set(peer, Date.now());
          this.emit({ kind: 'unavailable', peer, route: routeLabel(transport) });
        }
        break;
      }

      case 'pdf-chunk': {
        // Received a PDF chunk from peer
        const chunk = message.payload as ChunkMessage;
        if (!chunk || chunk.documentId !== this.documentId || this.pdfAcquired) return;
        this.lastChunkAt = Date.now();

        if (!this.pdfReassembler) {
          this.pdfReassembler = new ChunkReassembler(this.documentId);
        }

        const { isComplete, progress } = this.pdfReassembler.addChunk(
          chunk.chunkIndex,
          chunk.totalChunks,
          chunk.data
        );

        if (this.options.onPdfProgress) {
          this.options.onPdfProgress(progress);
        }

        if (isComplete) {
          try {
            const assembledBytes = await this.pdfReassembler.assembleAndVerify();
            const filename = chunk.filename || 'Document.pdf';
            if (this.pdfAcquired) break; // another peer's copy finished first
            this.pdfAcquired = true;
            await storeOriginalPDF(this.documentId, assembledBytes, filename);
            this.stopPdfPolling();

            this.emit({ kind: 'received', bytes: assembledBytes.byteLength });
            if (this.options.onPdfAvailable) {
              this.options.onPdfAvailable(assembledBytes, filename);
            }
          } catch (err) {
            console.error('Failed to assemble and verify PDF chunks:', err);
            this.lastChunkAt = 0; // re-request on next poll
            this.emit({ kind: 'verify-failed', reason: err instanceof Error ? err.message : String(err) });
          }
          this.pdfReassembler = null;
        }
        break;
      }
    }
  }

  /**
   * Request original PDF bytes from connected peers
   */
  public requestPDFFromPeers(viaRelay = this.directLinkCount() === 0, alwaysLog = false) {
    if (this.destroyed) return;
    const missing = this.pdfReassembler?.missingIndices() ?? [];
    const msg: PeerMessage = {
      type: 'request-pdf',
      payload: { documentId: this.documentId, ...(missing.length ? { missing } : {}) },
    };
    const used = this.transports.filter((t) => !t.relay || viaRelay);
    used.forEach((t) => t.broadcast(msg));

    // Log only when the route set changes or every 15s, not on every poll tick
    const routes = [...new Set(used.filter((t) => this.linkCount(t) > 0).map(routeLabel))];
    const key = routes.join('|');
    if (routes.length && (alwaysLog || key !== this.lastRequestLog.key || Date.now() - this.lastRequestLog.at > 15000)) {
      this.lastRequestLog = { key, at: Date.now() };
      this.emit({ kind: 'requested', routes, peers: this.getConnectedPeerCount() });
    }
  }

  private emit(event: PdfTransferEvent) {
    this.options.onPdfTransferEvent?.(event);
  }

  private linkCount(t: SyncTransport): number {
    let n = 0;
    for (const key of this.activePeers.keys()) if (key.startsWith(`${t.name}:`)) n++;
    return n;
  }

  /** Short, stable label for a remote tab (its session ID when known). */
  private peerLabel(t: SyncTransport, peerId: string): string {
    return (this.activePeers.get(`${t.name}:${peerId}`) || peerId).slice(0, 6);
  }

  /** Every direct link answered "no PDF here": no point waiting before using the relay. */
  private allDirectLinksRefused(): boolean {
    const direct = [...this.activePeers.keys()].filter((k) =>
      this.transports.some((t) => !t.relay && k.startsWith(`${t.name}:`))
    );
    return direct.length > 0 && direct.every((k) => this.refusedLinks.has(k));
  }

  /** Links over non-relay transports (BroadcastChannel, WebRTC). */
  private directLinkCount(): number {
    return this.transports.filter((t) => !t.relay).reduce((n, t) => n + this.linkCount(t), 0);
  }


  private notifyPeers() {
    if (this.options.onPeersChange) {
      this.options.onPeersChange(this.getConnectedPeerCount());
    }
  }

  /** Distinct remote tabs: identified sessions deduped, unidentified links counted as-is. */
  public getConnectedPeerCount(): number {
    const sessions = new Set<string>();
    let unidentified = 0;
    for (const session of this.activePeers.values()) {
      if (session) sessions.add(session);
      else unidentified++;
    }
    return sessions.size + unidentified;
  }

  public destroy() {
    const awareness = this.options.awareness;
    if (awareness) {
      // Announce departure on every transport while they are still open
      removeAwarenessStates(awareness, [awareness.clientID], 'local');
      awareness.off('update', this.handleAwarenessUpdate);
      if (this.relayAwarenessTimer) {
        clearTimeout(this.relayAwarenessTimer);
        this.relayAwarenessTimer = null;
        const goodbye = this.localAwarenessMessage();
        for (const transport of this.transports) if (transport.relay) transport.broadcast(goodbye);
      }
    }
    this.destroyed = true;
    this.stopPdfPolling();
    this.doc.off('update', this.handleLocalDocUpdate);
    for (const transport of this.transports) {
      transport.disconnect();
    }
    this.activePeers.clear();
  }
}

/** A dumb broadcast medium: every subscriber of the room receives every posted message. */
export interface PubSubBus {
  /** `targetId` lets a bus deliver only to that peer (e.g. its own inbox topic). */
  post(msg: any, targetId?: string): void;
  close(): void;
}
export type PubSubBusFactory = (roomId: string, onMessage: (msg: any) => void, selfId: string) => PubSubBus;

/**
 * Peer presence + addressed messaging on top of any broadcast bus
 * (BroadcastChannel locally, an encrypted MQTT topic as network relay).
 */
export class PubSubTransport implements SyncTransport {
  private bus: PubSubBus | null = null;
  private myPeerId: string = crypto.randomUUID();
  private peerJoinCbs: ((peerId: string) => void)[] = [];
  private peerLeaveCbs: ((peerId: string) => void)[] = [];
  private messageCbs: ((peerId: string, message: PeerMessage) => void)[] = [];
  private peers: Map<string, number> = new Map(); // peerId -> last seen
  private heartbeatInterval: any = null;
  private static PEER_TIMEOUT_MS = 75000; // > Chrome hidden-tab timer throttle (1/min)

  constructor(
    public readonly name: string,
    private openBus: PubSubBusFactory,
    public readonly relay = false
  ) {}

  // Tabs that close or crash never run React cleanup, so peers must expire.
  private seen(senderId: string) {
    const isNew = !this.peers.has(senderId);
    this.peers.set(senderId, Date.now());
    if (isNew) this.peerJoinCbs.forEach((cb) => cb(senderId));
    return isNew;
  }

  private dropPeer(peerId: string) {
    if (this.peers.delete(peerId)) this.peerLeaveCbs.forEach((cb) => cb(peerId));
  }

  private post(msg: Record<string, any>) {
    this.bus?.post({ senderId: this.myPeerId, ...msg }, msg.targetId);
  }

  private handlePageHide = () => this.post({ type: 'leave' });

  connect(roomId: string): void {
    this.bus = this.openBus(roomId, (data) => {
      const { senderId, targetId, type, message } = data || {};
      if (!senderId || senderId === this.myPeerId) return;

      if (type === 'announce') {
        // Reply with ack so they know about us
        if (this.seen(senderId)) this.post({ targetId: senderId, type: 'announce-ack' });
      } else if (type === 'announce-ack') {
        if (targetId === this.myPeerId) this.seen(senderId);
      } else if (type === 'leave') {
        this.dropPeer(senderId);
      } else if (type === 'data') {
        if (!targetId || targetId === this.myPeerId) {
          this.seen(senderId);
          this.messageCbs.forEach((cb) => cb(senderId, message));
        }
      }
    }, this.myPeerId);

    this.post({ type: 'announce' });

    // Heartbeat to keep track of live peers; expire silent ones
    this.heartbeatInterval = setInterval(() => {
      this.post({ type: 'announce' });
      const now = Date.now();
      for (const [peerId, lastSeen] of this.peers) {
        if (now - lastSeen > PubSubTransport.PEER_TIMEOUT_MS) this.dropPeer(peerId);
      }
    }, 5000);

    if (typeof window !== 'undefined') window.addEventListener('pagehide', this.handlePageHide);
  }

  disconnect(): void {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', this.handlePageHide);
    if (this.bus) {
      try {
        this.post({ type: 'leave' });
        this.bus.close();
      } catch (e) {}
      this.bus = null;
    }
    this.peers.clear();
  }

  sendToPeer(peerId: string, message: PeerMessage): void {
    this.post({ targetId: peerId, type: 'data', message });
  }

  broadcast(message: PeerMessage): void {
    this.post({ type: 'data', message });
  }

  onPeerJoin(cb: (peerId: string) => void): void {
    this.peerJoinCbs.push(cb);
  }

  onPeerLeave(cb: (peerId: string) => void): void {
    this.peerLeaveCbs.push(cb);
  }

  onMessage(cb: (peerId: string, message: PeerMessage) => void): void {
    this.messageCbs.push(cb);
  }

  getPeers(): string[] {
    return Array.from(this.peers.keys());
  }
}

/** Same-browser tab-to-tab sync with zero network requirement. */
export class BroadcastChannelTransport extends PubSubTransport {
  constructor() {
    super('BroadcastChannel', (roomId, onMessage) => {
      const channel = new BroadcastChannel(`editordoc_room_${roomId}`);
      channel.onmessage = (event) => onMessage(event.data);
      return { post: (msg) => channel.postMessage(msg), close: () => channel.close() };
    });
  }
}
