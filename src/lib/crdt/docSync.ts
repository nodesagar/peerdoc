import * as Y from 'yjs';
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

export interface PeerMessage {
  type: 'state-vector' | 'state-update' | 'request-pdf' | 'pdf-chunk';
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

export interface DocSyncOptions {
  doc: Y.Doc;
  documentId: string;
  transports: SyncTransport[];
  getLocalPdfBytes?: () => Uint8Array | null;
  onPeersChange?: (peersCount: number) => void;
  onPdfAvailable?: (bytes: Uint8Array, filename?: string) => void;
  onPdfProgress?: (progress: number) => void;
}

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

    // 2. Initialize all transports
    for (const transport of this.transports) {
      transport.onPeerJoin((peerId) => this.handlePeerJoin(transport, peerId));
      transport.onPeerLeave((peerId) => this.handlePeerLeave(transport, peerId));
      transport.onMessage((peerId, message) => this.handlePeerMessage(transport, peerId, message));
      transport.connect(this.documentId);
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
      const inDb = await hasOriginalPDF(this.documentId);
      if (inDb) {
        this.stopPdfPolling();
        return;
      }
      // If we have connected peers and still lack PDF, request again
      // (but not while a transfer is actively streaming in - that restarts it)
      if (this.activePeers.size > 0 && Date.now() - this.lastChunkAt > 5000) {
        const relayDue =
          this.firstRelayLinkAt > 0 && Date.now() - this.firstRelayLinkAt > DocSyncEngine.RELAY_GRACE_MS;
        this.requestPDFFromPeers(relayDue && this.directLinkCount() === 0);
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
    this.activePeers.delete(`${transport.name}:${peerId}`);
    this.notifyPeers();
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

        if (bytes && bytes.byteLength > 0) {
          const chunks = chunkPDF(this.documentId, bytes, filename);
          for (let i = 0; i < chunks.length; i++) {
            if (this.destroyed) break;
            transport.sendToPeer(peerId, {
              type: 'pdf-chunk',
              payload: chunks[i],
            });
            // Pacing: avoid flooding the DataChannel / tripping public broker rate limits
            if (transport.relay) {
              await new Promise((r) => setTimeout(r, 40));
            } else if (chunks.length > 2 && i % 4 === 0) {
              await new Promise((r) => setTimeout(r, 6));
            }
          }
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

            if (this.options.onPdfAvailable) {
              this.options.onPdfAvailable(assembledBytes, filename);
            }
          } catch (err) {
            console.error('Failed to assemble and verify PDF chunks:', err);
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
  public requestPDFFromPeers(viaRelay = this.directLinkCount() === 0) {
    if (this.destroyed) return;
    const msg: PeerMessage = {
      type: 'request-pdf',
      payload: { documentId: this.documentId },
    };
    for (const t of this.transports) {
      if (!t.relay || viaRelay) t.broadcast(msg);
    }
  }

  /** Links over non-relay transports (BroadcastChannel, WebRTC). */
  private directLinkCount(): number {
    let n = 0;
    for (const t of this.transports) {
      if (t.relay) continue;
      for (const key of this.activePeers.keys()) if (key.startsWith(`${t.name}:`)) n++;
    }
    return n;
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
  post(msg: any): void;
  close(): void;
}
export type PubSubBusFactory = (roomId: string, onMessage: (msg: any) => void) => PubSubBus;

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
    this.bus?.post({ senderId: this.myPeerId, ...msg });
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
    });

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
