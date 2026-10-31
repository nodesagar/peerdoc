import { describe, it, expect, vi } from 'vitest';

/** Poll for async outcomes instead of sleeping a fixed time. */
const WAIT = { timeout: 4000, interval: 10 };
import * as Y from 'yjs';
import {
  computeSHA256,
  chunkPDF,
  ChunkReassembler,
  uint8ArrayToBase64,
  normalizeToUint8Array,
} from '../lib/crdt/pdfStore';
import { DocSyncEngine, SyncTransport, PeerMessage } from '../lib/crdt/docSync';
import { exportSyncFile, importSyncFile } from '../lib/crdt/fileSync';
import { addWhiteoutCRDT, readDocumentSnapshot } from '../lib/crdt/schema';

/**
 * Mock transport simulating Trystero WebRTC behavior:
 * Everything sent passes through JSON.stringify -> JSON.parse!
 */
class SimulatedWebRtcTransport implements SyncTransport {
  public name = 'SimulatedWebRTC';
  public connectedRoom: string | null = null;
  private peerJoinCbs: ((peerId: string) => void)[] = [];
  private peerLeaveCbs: ((peerId: string) => void)[] = [];
  private messageCbs: ((peerId: string, message: PeerMessage) => void)[] = [];
  public peerNetwork: Map<string, SimulatedWebRtcTransport> = new Map();
  public myId: string;

  constructor(myId: string) {
    this.myId = myId;
  }

  connect(roomId: string): void {
    this.connectedRoom = roomId;
  }

  disconnect(): void {
    this.connectedRoom = null;
  }

  sendToPeer(peerId: string, message: PeerMessage): void {
    // Trystero performs JSON serialization on non-binary objects
    const serialized = JSON.parse(JSON.stringify(message));
    const target = this.peerNetwork.get(peerId);
    if (target && target.connectedRoom === this.connectedRoom) {
      setTimeout(() => {
        target.messageCbs.forEach((cb) => cb(this.myId, serialized));
      }, 0);
    }
  }

  broadcast(message: PeerMessage): void {
    const serialized = JSON.parse(JSON.stringify(message));
    this.peerNetwork.forEach((peer, peerId) => {
      if (peerId !== this.myId && peer.connectedRoom === this.connectedRoom) {
        setTimeout(() => {
          peer.messageCbs.forEach((cb) => cb(this.myId, serialized));
        }, 0);
      }
    });
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
    return Array.from(this.peerNetwork.keys()).filter((id) => id !== this.myId);
  }

  simulateJoin(peerId: string): void {
    this.peerJoinCbs.forEach((cb) => cb(peerId));
  }
}

describe('P2P Document Sharing & Binary Chunking', () => {
  it('survives JSON serialization across WebRTC without data loss', async () => {
    // 100KB mock PDF
    const mockBytes = new Uint8Array(100 * 1024);
    for (let i = 0; i < mockBytes.byteLength; i++) {
      mockBytes[i] = (i * 13) % 256;
    }

    const docId = await computeSHA256(mockBytes);
    const chunks = chunkPDF(docId, mockBytes, 'Contract.pdf');

    // Simulate WebRTC JSON transfer
    const reassembler = new ChunkReassembler(docId.toUpperCase()); // test case insensitivity
    let lastProgress = 0;

    for (const chunk of chunks) {
      const overWire = JSON.parse(JSON.stringify(chunk));
      const { isComplete, progress } = reassembler.addChunk(
        overWire.chunkIndex,
        overWire.totalChunks,
        overWire.data
      );
      lastProgress = progress;
      if (isComplete) break;
    }

    expect(lastProgress).toBe(100);
    const reassembled = await reassembler.assembleAndVerify();
    expect(reassembled.byteLength).toBe(mockBytes.byteLength);

    expect(Buffer.compare(reassembled, mockBytes)).toBe(0); // byte-for-byte, native memcmp
  });

  it('automatically requests and delivers PDF when Peer B connects with empty document', async () => {
    const mockPdf = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55, 10, 49, 50, 51]); // %PDF-1.7\n123
    const documentId = await computeSHA256(mockPdf);

    const docA = new Y.Doc();
    const docB = new Y.Doc();

    const transportA = new SimulatedWebRtcTransport('peer-A');
    const transportB = new SimulatedWebRtcTransport('peer-B');

    transportA.peerNetwork.set('peer-A', transportA);
    transportA.peerNetwork.set('peer-B', transportB);
    transportB.peerNetwork.set('peer-A', transportA);
    transportB.peerNetwork.set('peer-B', transportB);

    let peerBReceivedPdf: Uint8Array | null = null;
    let peerBReceivedFilename: string | undefined = undefined;

    // Engine A (has PDF bytes in memory)
    const engineA = new DocSyncEngine({
      doc: docA,
      documentId,
      transports: [transportA],
      getLocalPdfBytes: () => mockPdf,
    });

    // Engine B (joining by doc ID, does not have PDF bytes)
    const engineB = new DocSyncEngine({
      doc: docB,
      documentId,
      transports: [transportB],
      getLocalPdfBytes: () => null,
      onPdfAvailable: (bytes, filename) => {
        peerBReceivedPdf = bytes;
        peerBReceivedFilename = filename;
      },
    });

    // Connect peers in room
    transportA.connect(documentId);
    transportB.connect(documentId);

    // Simulate WebRTC peer join event triggered for both peers
    transportA.simulateJoin('peer-B');
    transportB.simulateJoin('peer-A');

    // Wait for the transfer itself, not a fixed time (slow on a busy machine)
    await vi.waitFor(() => expect(peerBReceivedPdf).not.toBeNull(), WAIT);
    expect(peerBReceivedPdf!.byteLength).toBe(mockPdf.byteLength);
    expect(peerBReceivedFilename).toBe('Document.pdf');

    engineA.destroy();
    engineB.destroy();
  });

  it('forwards .cdsync imports to currently connected peers', async () => {
    const documentId = 'a'.repeat(64);
    const [docA, docB] = [new Y.Doc(), new Y.Doc()];
    const tA = new SimulatedWebRtcTransport('peer-A');
    const tB = new SimulatedWebRtcTransport('peer-B');
    for (const t of [tA, tB]) {
      t.peerNetwork.set('peer-A', tA);
      t.peerNetwork.set('peer-B', tB);
    }
    const engines = [
      new DocSyncEngine({ doc: docA, documentId, transports: [tA], getLocalPdfBytes: () => new Uint8Array([1]) }),
      new DocSyncEngine({ doc: docB, documentId, transports: [tB], getLocalPdfBytes: () => new Uint8Array([1]) }),
    ];

    // Offline peer C's edits arrive at A via a sync file
    const docC = new Y.Doc();
    addWhiteoutCRDT(docC, { pageIndex: 0, x: 1, y: 1, width: 5, height: 5 });
    const { blob } = exportSyncFile(docC, documentId);
    await importSyncFile(blob, docA, documentId);

    await vi.waitFor(() => expect(readDocumentSnapshot(docB).whiteouts.length).toBe(1), WAIT);
    engines.forEach((e) => e.destroy());
  });

  it('counts a remote tab reached over two transports as one peer', async () => {
    const documentId = 'b'.repeat(64);
    const net = (idA: string, idB: string) => {
      const ta = new SimulatedWebRtcTransport(idA);
      const tb = new SimulatedWebRtcTransport(idB);
      for (const t of [ta, tb]) {
        t.peerNetwork.set(idA, ta);
        t.peerNetwork.set(idB, tb);
      }
      return [ta, tb];
    };
    const [a1, b1] = net('A-bc', 'B-bc');
    const [a2, b2] = net('A-rtc', 'B-rtc');
    const pdf = () => new Uint8Array([1]);
    const engineA = new DocSyncEngine({ doc: new Y.Doc(), documentId, transports: [a1, a2], getLocalPdfBytes: pdf });
    const engineB = new DocSyncEngine({ doc: new Y.Doc(), documentId, transports: [b1, b2], getLocalPdfBytes: pdf });

    a1.simulateJoin('B-bc');
    b1.simulateJoin('A-bc');
    a2.simulateJoin('B-rtc');
    b2.simulateJoin('A-rtc');

    // Wait until both sessions have identified themselves on both links
    await vi.waitFor(() => {
      expect(engineA.getConnectedPeerCount()).toBe(1);
      expect(engineB.getConnectedPeerCount()).toBe(1);
    }, WAIT);
    engineA.destroy();
    engineB.destroy();
  });
});
