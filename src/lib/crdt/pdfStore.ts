import { get, set, createStore } from 'idb-keyval';

// Separate IndexedDB store for large PDF binary blobs
const pdfStoreDb = createStore('editordoc_pdf_db', 'original_pdfs');
const CHUNK_SIZE = 32 * 1024; // 32KB chunks for reliable WebRTC DataChannel transfer

export interface ChunkMessage {
  documentId: string;
  chunkIndex: number;
  totalChunks: number;
  data: string | ArrayBuffer | Uint8Array;
  filename?: string;
}

export interface TransferProgress {
  documentId: string;
  receivedChunks: number;
  totalChunks: number;
  percentage: number;
}

/**
 * Converts Uint8Array to Base64 string for safe JSON serialization across transports.
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i += 8192) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, len)) as any);
  }
  return btoa(binary);
}

/**
 * Converts Base64 string back to Uint8Array.
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Normalizes any incoming data format (Base64 string, Uint8Array, ArrayBuffer, or numeric-keyed JSON object)
 * into a clean, verified Uint8Array.
 */
export function normalizeToUint8Array(data: any): Uint8Array {
  if (!data) return new Uint8Array(0);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof data === 'string') {
    try {
      return base64ToUint8Array(data);
    } catch {
      return new Uint8Array(0);
    }
  }
  if (Array.isArray(data)) return new Uint8Array(data);
  if (typeof data === 'object') {
    const keys = Object.keys(data);
    if (keys.length > 0 && typeof (data as any)[0] === 'number') {
      const arr = new Uint8Array(keys.length);
      for (let i = 0; i < keys.length; i++) {
        arr[i] = (data as any)[i];
      }
      return arr;
    }
  }
  return new Uint8Array(0);
}

/**
 * Computes SHA-256 hex digest of Uint8Array bytes.
 */
export async function computeSHA256(bytes: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes as any);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Store original PDF bytes in IndexedDB by documentId (SHA-256 hash).
 */
export async function storeOriginalPDF(
  documentId: string,
  bytes: Uint8Array,
  filename?: string
): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  try {
    const cleanId = documentId.trim().toLowerCase();
    await set(
      cleanId,
      {
        bytes,
        filename: filename || 'Document.pdf',
        storedAt: Date.now(),
      },
      pdfStoreDb
    );
  } catch (err) {
    console.warn('Failed to store PDF in indexedDB:', err);
  }
}

/**
 * Retrieve original PDF bytes from IndexedDB.
 */
export async function getOriginalPDF(
  documentId: string
): Promise<{ bytes: Uint8Array; filename: string } | null> {
  if (typeof indexedDB === 'undefined') return null;
  try {
    const cleanId = documentId.trim().toLowerCase();
    const entry = await get<{ bytes: Uint8Array; filename: string }>(
      cleanId,
      pdfStoreDb
    );
    if (!entry || !entry.bytes) return null;
    return {
      bytes: new Uint8Array(entry.bytes),
      filename: entry.filename || 'Document.pdf',
    };
  } catch (err) {
    console.warn('Failed to read PDF from indexedDB:', err);
    return null;
  }
}

/**
 * Check if the original PDF exists locally.
 */
export async function hasOriginalPDF(documentId: string): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false;
  try {
    const cleanId = documentId.trim().toLowerCase();
    const entry = await get(cleanId, pdfStoreDb);
    return Boolean(entry);
  } catch {
    return false;
  }
}

/**
 * Chunk a PDF byte buffer into sequential Base64-encoded messages for reliable peer transmission.
 */
export function chunkPDF(
  documentId: string,
  bytes: Uint8Array,
  filename?: string
): ChunkMessage[] {
  const totalChunks = Math.ceil(bytes.byteLength / CHUNK_SIZE);
  const chunks: ChunkMessage[] = [];
  const cleanId = documentId.trim().toLowerCase();

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, bytes.byteLength);
    const slice = bytes.subarray(start, end);
    chunks.push({
      documentId: cleanId,
      chunkIndex: i,
      totalChunks,
      data: uint8ArrayToBase64(slice),
      filename,
    });
  }

  return chunks;
}

/**
 * Reassemble chunks into full PDF bytes and verify SHA-256 checksum.
 */
export class ChunkReassembler {
  private chunks: Map<number, Uint8Array> = new Map();
  private totalChunks: number | null = null;
  public readonly documentId: string;

  constructor(documentId: string) {
    this.documentId = documentId.trim().toLowerCase();
  }

  public addChunk(
    chunkIndex: number,
    totalChunks: number,
    data: string | ArrayBuffer | Uint8Array
  ): { isComplete: boolean; progress: number } {
    this.totalChunks = totalChunks;
    this.chunks.set(chunkIndex, normalizeToUint8Array(data));

    const progress = Math.round((this.chunks.size / totalChunks) * 100);
    const isComplete = this.chunks.size === totalChunks;

    return { isComplete, progress };
  }

  /** Chunk indices still missing (empty until the total is known). */
  public missingIndices(): number[] {
    if (!this.totalChunks) return [];
    const missing: number[] = [];
    for (let i = 0; i < this.totalChunks; i++) if (!this.chunks.has(i)) missing.push(i);
    return missing;
  }

  public async assembleAndVerify(): Promise<Uint8Array> {
    if (!this.totalChunks || this.chunks.size !== this.totalChunks) {
      throw new Error(`Incomplete chunks: received ${this.chunks.size}/${this.totalChunks}`);
    }

    let totalLength = 0;
    for (let i = 0; i < this.totalChunks; i++) {
      const c = this.chunks.get(i);
      if (!c) throw new Error(`Missing chunk at index ${i}`);
      totalLength += c.byteLength;
    }

    const fullBuffer = new Uint8Array(totalLength);
    let offset = 0;
    for (let i = 0; i < this.totalChunks; i++) {
      const c = this.chunks.get(i)!;
      fullBuffer.set(c, offset);
      offset += c.byteLength;
    }

    // Hash verification (case-insensitive)
    const computed = await computeSHA256(fullBuffer);
    if (computed.toLowerCase() !== this.documentId.toLowerCase()) {
      throw new Error(`SHA-256 mismatch: expected ${this.documentId}, calculated ${computed}`);
    }

    return fullBuffer;
  }
}

