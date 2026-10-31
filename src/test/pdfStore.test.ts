import { describe, it, expect } from 'vitest';
import { computeSHA256, chunkPDF, ChunkReassembler } from '../lib/crdt/pdfStore';

describe('PDF Store & Binary Chunker', () => {
  it('computes deterministic SHA-256 digests', async () => {
    const data = new TextEncoder().encode('Hello EditorDoc P2P');
    const hash1 = await computeSHA256(data);
    const hash2 = await computeSHA256(data);

    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(64);
  });

  it('chunks a large binary buffer and successfully reassembles with verified checksum', async () => {
    // Generate 120KB mock PDF bytes (spans ~3 chunks)
    const mockSize = 120 * 1024;
    const mockBytes = new Uint8Array(mockSize);
    for (let i = 0; i < mockSize; i++) {
      mockBytes[i] = (i * 7) % 256;
    }

    const documentId = await computeSHA256(mockBytes);
    const chunks = chunkPDF(documentId, mockBytes);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].chunkIndex).toBe(0);

    // Reassemble chunks
    const reassembler = new ChunkReassembler(documentId);
    let complete = false;

    // Simulate arriving out-of-order
    const shuffled = [...chunks].reverse();
    for (const c of shuffled) {
      const res = reassembler.addChunk(c.chunkIndex, c.totalChunks, c.data);
      complete = res.isComplete;
    }

    expect(complete).toBe(true);

    const assembledBytes = await reassembler.assembleAndVerify();
    expect(assembledBytes.byteLength).toBe(mockSize);

    // Byte-for-byte identity via native memcmp: per-byte expect() took 0.7 s and
    // toEqual 0.2 s, enough to hit the 5 s test timeout on a busy machine
    expect(Buffer.compare(assembledBytes, mockBytes)).toBe(0);
  });

  it('rejects tampered or corrupted chunks during verification', async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const documentId = await computeSHA256(data);

    const reassembler = new ChunkReassembler(documentId);
    // Tamper with data byte
    const corruptedData = new Uint8Array([1, 2, 99, 4, 5]).buffer as ArrayBuffer;
    reassembler.addChunk(0, 1, corruptedData);

    await expect(reassembler.assembleAndVerify()).rejects.toThrow('SHA-256 mismatch');
  });
});
