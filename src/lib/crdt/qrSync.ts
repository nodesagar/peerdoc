import * as Y from 'yjs';

export const QR_FRAME_PREFIX = 'CD1';
export const DEFAULT_CHUNK_SIZE = 280;
export const MAX_QR_FRAMES = 30;

export interface FrameAddResult {
  progress: number;
  received: number;
  total: number;
  complete: boolean;
  error?: string;
}

export function normalizeDocIdShort(documentId: string): string {
  return documentId.trim().toLowerCase().slice(0, 8);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Deterministic short hash of a Y.Doc's state vector + state content so both
 * peers can verify they converged to the exact same state after two-way QR sync.
 */
export async function computeDocStateHash(doc: Y.Doc): Promise<string> {
  const sv = Y.encodeStateVector(doc);
  const hex = await sha256Hex(sv);
  return hex.slice(0, 8);
}

export function uint8ToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, Array.from(sub));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToUint8(b64url: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(b64url)) {
    throw new Error('Invalid base64url characters');
  }
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  const readPromise = collectStream(cs.readable);
  await writer.write(copy);
  await writer.close();
  return readPromise;
}

export async function inflateRaw(compressed: Uint8Array): Promise<Uint8Array> {
  const copy = new Uint8Array(compressed.byteLength);
  copy.set(compressed);
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  const readPromise = collectStream(ds.readable);
  await writer.write(copy);
  await writer.close();
  return readPromise;
}

/**
 * Encodes a Y.Doc into a sequence of QR frame strings:
 * `CD1|<docIdShort>|<sessionId>|<index>|<total>|<base64url chunk>`
 */
export async function buildFrames(
  doc: Y.Doc,
  documentId: string,
  chunkSize: number = DEFAULT_CHUNK_SIZE
): Promise<string[]> {
  const docIdShort = normalizeDocIdShort(documentId);
  if (docIdShort.length < 8) {
    throw new Error('documentId must be at least 8 characters');
  }

  const update = Y.encodeStateAsUpdate(doc);
  const compressed = await deflateRaw(update);
  const sessionId = (await sha256Hex(compressed)).slice(0, 6);
  const b64 = uint8ToBase64Url(compressed);

  const chunks: string[] = [];
  if (b64.length === 0) {
    chunks.push('');
  } else {
    const totalFrames = Math.max(1, Math.ceil(b64.length / chunkSize));
    const balancedSize = Math.max(1, Math.ceil(b64.length / totalFrames));
    for (let i = 0; i < b64.length; i += balancedSize) {
      chunks.push(b64.slice(i, i + balancedSize));
    }
  }

  const total = chunks.length;
  return chunks.map(
    (chunk, index) => `${QR_FRAME_PREFIX}|${docIdShort}|${sessionId}|${index}|${total}|${chunk}`
  );
}

/**
 * Collects out-of-order and duplicate QR frames for a given document and
 * reassembles + verifies the compressed Yjs update.
 */
export class FrameCollector {
  private readonly expectedDocIdShort: string;
  private sessionId: string | null = null;
  private total: number = 0;
  private chunks: Map<number, string> = new Map();

  constructor(documentId: string) {
    this.expectedDocIdShort = normalizeDocIdShort(documentId);
  }

  reset(): void {
    this.sessionId = null;
    this.total = 0;
    this.chunks.clear();
  }

  get progress(): number {
    return this.total > 0 ? this.chunks.size / this.total : 0;
  }

  get isComplete(): boolean {
    return this.total > 0 && this.chunks.size === this.total;
  }

  get receivedCount(): number {
    return this.chunks.size;
  }

  get totalCount(): number {
    return this.total;
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  get receivedIndices(): number[] {
    return Array.from(this.chunks.keys()).sort((a, b) => a - b);
  }

  add(frameString: string): FrameAddResult {
    const trimmed = (frameString || '').trim();
    const parts = trimmed.split('|');
    if (parts.length !== 6) {
      return this.statusWithError('Invalid QR frame format');
    }

    const [prefix, docIdShort, sessionId, indexStr, totalStr, chunk] = parts;
    if (prefix !== QR_FRAME_PREFIX) {
      return this.statusWithError('Unrecognized QR protocol version');
    }

    if (docIdShort.toLowerCase() !== this.expectedDocIdShort) {
      return this.statusWithError(
        `Document ID mismatch: expected ${this.expectedDocIdShort}, got ${docIdShort}`
      );
    }

    if (!/^[0-9a-f]{6}$/i.test(sessionId)) {
      return this.statusWithError('Invalid session ID in QR frame');
    }

    const index = Number(indexStr);
    const total = Number(totalStr);
    if (
      !Number.isInteger(index) ||
      !Number.isInteger(total) ||
      total < 1 ||
      index < 0 ||
      index >= total
    ) {
      return this.statusWithError('Invalid frame index or total count');
    }

    if (!chunk || !/^[A-Za-z0-9_-]+$/.test(chunk)) {
      return this.statusWithError('Invalid base64url payload chunk');
    }

    const normalizedSession = sessionId.toLowerCase();
    if (this.sessionId !== null && this.sessionId !== normalizedSession) {
      return this.statusWithError(
        `Different session ID (${normalizedSession} vs active ${this.sessionId})`
      );
    }

    if (this.total !== 0 && this.total !== total) {
      return this.statusWithError('Frame total mismatch within session');
    }

    this.sessionId = normalizedSession;
    this.total = total;
    this.chunks.set(index, chunk);

    return {
      progress: this.progress,
      received: this.chunks.size,
      total: this.total,
      complete: this.isComplete,
    };
  }

  async finish(): Promise<Uint8Array> {
    if (!this.isComplete || !this.sessionId || this.total < 1) {
      throw new Error(
        `Cannot finish incomplete QR transfer (${this.chunks.size}/${this.total} frames)`
      );
    }

    const ordered: string[] = [];
    for (let i = 0; i < this.total; i++) {
      const part = this.chunks.get(i);
      if (part === undefined) {
        throw new Error(`Missing QR frame at index ${i}`);
      }
      ordered.push(part);
    }

    const combinedBase64Url = ordered.join('');
    const compressed = base64UrlToUint8(combinedBase64Url);
    const actualHash = (await sha256Hex(compressed)).slice(0, 6).toLowerCase();

    if (actualHash !== this.sessionId) {
      throw new Error(
        `Checksum mismatch: expected ${this.sessionId}, computed ${actualHash}`
      );
    }

    return inflateRaw(compressed);
  }

  private statusWithError(error: string): FrameAddResult {
    return {
      progress: this.progress,
      received: this.chunks.size,
      total: this.total,
      complete: this.isComplete,
      error,
    };
  }
}

