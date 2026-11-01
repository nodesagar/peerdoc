import { get, set, del } from 'idb-keyval';
import { ActiveTool, DocAction, ProcessedDoc } from '../types';
import type { DocumentSnapshot } from './crdt/schema';
import { detectFormat, FORMAT_LABEL } from './formats';
import { listStoredPDFs, clearStoredPDFs } from './crdt/pdfStore';
import { formatBytes } from '../utils/pdfProcessor';

export const RECENT_DOCS_KEY = 'editordoc_recent_docs';
export const ACTIVE_DOC_SESSION_KEY = 'editordoc_active_doc_session';
export const CACHE_SEEDED_KEY = 'editordoc_recent_cache_seeded';
export const RECENT_CACHE_NAME = 'peerdoc-recent-history-v1';
const RECENT_CACHE_URL = '/__peerdoc_recent_docs__';

export interface ActiveDocSession {
  documentId: string;
  fileName: string;
  format?: 'pdf' | 'docx' | 'doc';
}

const memoryStorage = new Map<string, string>();

function storageGet(key: string): string | null {
  try {
    if (typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function') {
      return localStorage.getItem(key);
    }
  } catch {
    // fallback
  }
  return memoryStorage.get(key) ?? null;
}

function storageSet(key: string, value: string): void {
  memoryStorage.set(key, value);
  try {
    if (typeof localStorage !== 'undefined' && typeof localStorage.setItem === 'function') {
      localStorage.setItem(key, value);
    }
  } catch {
    // ignore quota errors
  }
}

function storageRemove(key: string): void {
  memoryStorage.delete(key);
  try {
    if (typeof localStorage !== 'undefined' && typeof localStorage.removeItem === 'function') {
      localStorage.removeItem(key);
    }
  } catch {
    // ignore
  }
}

export function resetRecentDocsMemoryForTest(): void {
  memoryStorage.clear();
}

/**
 * Formats a timestamp as a human-readable relative time string.
 */
export function formatTimeAgo(timestamp: number, now: number = Date.now()): string {
  if (!timestamp || timestamp <= 0) return 'Just now';
  const diffSec = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (diffSec < 45) return 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: new Date(timestamp).getFullYear() !== new Date(now).getFullYear() ? 'numeric' : undefined,
  });
}

/**
 * Formats a timestamp as a short date + time string for table display.
 */
export function formatDateTime(timestamp: number): string {
  if (!timestamp || timestamp <= 0) return '—';
  try {
    return new Date(timestamp).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

/**
 * Infers document format from filename when bytes aren't inspected.
 */
export function inferFormatFromName(name: string): 'pdf' | 'docx' | 'doc' | undefined {
  const lower = (name || '').toLowerCase().trim();
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.doc')) return 'doc';
  if (lower.endsWith('.pdf')) return 'pdf';
  return undefined;
}

/**
 * Upserts a document into the recent documents list, deduplicating by `documentId` (or `id`),
 * preserving prior rich metadata, and sorting most-recently-worked first.
 */
export function upsertRecentDocList(
  prev: ProcessedDoc[],
  incoming: ProcessedDoc,
  now: number = Date.now()
): ProcessedDoc[] {
  const matchIdx = prev.findIndex(
    (d) => (incoming.documentId && d.documentId === incoming.documentId) || d.id === incoming.id
  );

  const existing = matchIdx >= 0 ? prev[matchIdx] : undefined;
  const timestamp = incoming.timestamp || now;

  // Keep meaningful action when merely reopening an already modified document
  const action: DocAction =
    incoming.action === 'Opened' && existing?.action && existing.action !== 'Opened'
      ? existing.action
      : incoming.action;

  const name =
    incoming.name && incoming.name !== 'Document.pdf'
      ? incoming.name
      : existing?.name || incoming.name || 'Document.pdf';

  const size =
    incoming.size && incoming.size !== '0 Bytes' && incoming.size !== '—'
      ? incoming.size
      : existing?.size || incoming.size || '—';

  const format = incoming.format ?? existing?.format ?? inferFormatFromName(name);
  const pageCount = incoming.pageCount ?? existing?.pageCount;
  const details = incoming.details ?? existing?.details;
  const tool = incoming.tool ?? existing?.tool;

  const merged: ProcessedDoc = {
    ...(existing || {}),
    ...incoming,
    id: incoming.documentId || existing?.id || incoming.id,
    documentId: incoming.documentId ?? existing?.documentId,
    name,
    action,
    size,
    originalSize: incoming.originalSize ?? existing?.originalSize,
    timestamp,
    timeAgo: formatTimeAgo(timestamp, now),
    blob: incoming.blob ?? existing?.blob,
    format,
    pageCount,
    tool,
    details,
  };

  const remaining = prev.filter((_, idx) => idx !== matchIdx);
  const combined = [merged, ...remaining];
  combined.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return combined.map((d) => ({
    ...d,
    timeAgo: formatTimeAgo(d.timestamp, now),
  }));
}

/**
 * Summarizes the modifications and work done on a CRDT document snapshot.
 */
export function summarizeSnapshotWork(
  snapshot: DocumentSnapshot,
  options: {
    isWordDoc?: boolean;
    activeTool?: ActiveTool;
    wordModified?: boolean;
    pageCount?: number;
  } = {}
): {
  hasModifications: boolean;
  action: DocAction;
  details: string;
  pageCount?: number;
} {
  const { isWordDoc = false, activeTool = 'edit', wordModified = false } = options;

  const textEditsCount = (snapshot.textEdits?.length ?? 0) + snapshot.textOverlays.length;
  const whiteoutsCount = snapshot.whiteouts.length;
  const annotationsCount = snapshot.annotations.length;
  const commentsCount = snapshot.comments.length;
  const redactionsCount = snapshot.redactions.length;
  const signaturesCount = snapshot.signatures.length;
  const rotatedPages = snapshot.pages.filter((p) => p.rotation !== 0).length;
  const deletedPages = snapshot.pages.filter((p) => p.deleted).length;
  const reorderedPages = snapshot.pages.some((p, i) => p.originalIndex !== i);
  const activePages =
    snapshot.pages.length > 0
      ? snapshot.pages.filter((p) => !p.deleted).length
      : options.pageCount;

  const hasPdfModifications =
    textEditsCount > 0 ||
    whiteoutsCount > 0 ||
    annotationsCount > 0 ||
    commentsCount > 0 ||
    redactionsCount > 0 ||
    signaturesCount > 0 ||
    rotatedPages > 0 ||
    deletedPages > 0 ||
    reorderedPages;

  const hasModifications = isWordDoc ? wordModified : hasPdfModifications;

  let action: DocAction = 'Opened';
  if (activeTool === 'redact' && redactionsCount > 0) {
    action = 'Redacted';
  } else if (activeTool === 'sign' && signaturesCount > 0) {
    action = 'Signed';
  } else if (activeTool === 'organize' && (rotatedPages > 0 || deletedPages > 0 || reorderedPages)) {
    action = 'Organized';
  } else if (hasModifications) {
    if (redactionsCount > 0 && textEditsCount === 0 && signaturesCount === 0) action = 'Redacted';
    else if (signaturesCount > 0 && textEditsCount === 0 && redactionsCount === 0) action = 'Signed';
    else if ((rotatedPages > 0 || deletedPages > 0 || reorderedPages) && textEditsCount === 0) action = 'Organized';
    else action = 'Edited';
  }

  const modParts: string[] = [];
  if (textEditsCount > 0) modParts.push(`${textEditsCount} text ${textEditsCount === 1 ? 'edit' : 'edits'}`);
  if (whiteoutsCount > 0) modParts.push(`${whiteoutsCount} ${whiteoutsCount === 1 ? 'whiteout' : 'whiteouts'}`);
  if (annotationsCount > 0) modParts.push(`${annotationsCount} ${annotationsCount === 1 ? 'annotation' : 'annotations'}`);
  if (commentsCount > 0) modParts.push(`${commentsCount} ${commentsCount === 1 ? 'comment' : 'comments'}`);
  if (redactionsCount > 0) modParts.push(`${redactionsCount} ${redactionsCount === 1 ? 'redaction' : 'redactions'}`);
  if (signaturesCount > 0) modParts.push(`${signaturesCount} ${signaturesCount === 1 ? 'signature' : 'signatures'}`);
  if (rotatedPages > 0) modParts.push(`${rotatedPages} ${rotatedPages === 1 ? 'page' : 'pages'} rotated`);
  if (deletedPages > 0) modParts.push(`${deletedPages} ${deletedPages === 1 ? 'page' : 'pages'} deleted`);
  if (reorderedPages) modParts.push('pages reordered');

  const prefixParts: string[] = [];
  if (isWordDoc) {
    prefixParts.push('Word document');
    if (wordModified && modParts.length === 0) modParts.push('edited');
  } else if (activePages && activePages > 0) {
    prefixParts.push(`${activePages} ${activePages === 1 ? 'page' : 'pages'}`);
  }

  const details =
    modParts.length > 0
      ? [...prefixParts, modParts.join(', ')].join(' • ')
      : prefixParts.join(' • ') || (isWordDoc ? 'Word document' : 'PDF document');

  return {
    hasModifications,
    action,
    details,
    pageCount: isWordDoc ? undefined : activePages,
  };
}

function serializeForStorage(docs: ProcessedDoc[]): Omit<ProcessedDoc, 'blob' | 'dataUrl'>[] {
  return docs.map(({ blob: _blob, dataUrl: _dataUrl, ...rest }) => rest);
}

/**
 * Saves the recent documents list to IndexedDB, localStorage, and Browser Cache Storage.
 */
export async function saveRecentDocs(docs: ProcessedDoc[]): Promise<void> {
  if (typeof indexedDB !== 'undefined') {
    try {
      await set(RECENT_DOCS_KEY, docs);
    } catch (err) {
      console.warn('Failed to store recent docs in IndexedDB:', err);
    }
  }

  const serializable = serializeForStorage(docs);
  const json = JSON.stringify(serializable);

  storageSet(RECENT_DOCS_KEY, json);

  try {
    if (typeof caches !== 'undefined') {
      const cache = await caches.open(RECENT_CACHE_NAME);
      await cache.put(
        RECENT_CACHE_URL,
        new Response(json, { headers: { 'Content-Type': 'application/json' } })
      );
      for (const d of docs) {
        if (d.blob) {
          await cache.put(
            `/__peerdoc_blob__/${encodeURIComponent(d.documentId || d.id)}`,
            new Response(d.blob, {
              headers: { 'Content-Type': d.blob.type || 'application/octet-stream' },
            })
          );
        }
      }
      storageSet(CACHE_SEEDED_KEY, '1');
    }
  } catch {
    // ignore in environments where Cache API is restricted
  }
}

/**
 * Loads recent documents from browser storage.
 * If the browser cache (Cache Storage or site storage) was erased, clears any stale remnants.
 */
export async function loadRecentDocs(now: number = Date.now()): Promise<ProcessedDoc[]> {
  // 1. Detect if Browser Cache ("Cached images and files") was erased after being seeded
  if (typeof caches !== 'undefined') {
    try {
      const wasSeeded = storageGet(CACHE_SEEDED_KEY) === '1';
      if (wasSeeded) {
        const hasCache = await caches.has(RECENT_CACHE_NAME);
        if (!hasCache) {
          storageRemove(RECENT_DOCS_KEY);
          storageRemove(ACTIVE_DOC_SESSION_KEY);
          storageRemove(CACHE_SEEDED_KEY);
          if (typeof indexedDB !== 'undefined') {
            await del(RECENT_DOCS_KEY).catch(() => {});
            await del(ACTIVE_DOC_SESSION_KEY).catch(() => {});
          }
          await clearStoredPDFs();
          return [];
        }
      }
    } catch {
      // ignore Cache API errors
    }
  }

  // 2. Read from IndexedDB first (preserves Blobs), fallback to localStorage
  let docs: ProcessedDoc[] = [];
  if (typeof indexedDB !== 'undefined') {
    try {
      const idbDocs = await get<ProcessedDoc[]>(RECENT_DOCS_KEY);
      if (Array.isArray(idbDocs) && idbDocs.length > 0) {
        docs = idbDocs;
      }
    } catch {
      // fallback below
    }
  }

  if (docs.length === 0) {
    try {
      const raw = storageGet(RECENT_DOCS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) docs = parsed;
      }
    } catch {
      // ignore parse errors
    }
  }

  // 3. Enrich existing saved entries with size/format from stored PDFs if needed
  try {
    const storedFiles = await listStoredPDFs();
    for (const item of storedFiles) {
      const format = detectFormat(item.bytes) ?? inferFormatFromName(item.filename) ?? 'pdf';
      docs = docs.map((d) => {
        if (d.documentId === item.documentId || d.id === item.documentId) {
          return {
            ...d,
            format: d.format ?? format,
            size: d.size && d.size !== '—' ? d.size : formatBytes(item.bytes.byteLength),
          };
        }
        return d;
      });
    }
  } catch {
    // ignore
  }

  docs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const refreshed = docs.map((d) => ({
    ...d,
    format: d.format ?? inferFormatFromName(d.name),
    timeAgo: formatTimeAgo(d.timestamp, now),
  }));

  if (refreshed.length > 0) {
    await saveRecentDocs(refreshed);
  }

  return refreshed;
}

/**
 * Persists (or clears when null) the active workspace document session so it survives page refreshes.
 */
export async function saveActiveDocSession(session: ActiveDocSession | null): Promise<void> {
  if (!session) {
    storageRemove(ACTIVE_DOC_SESSION_KEY);
    if (typeof indexedDB !== 'undefined') {
      await del(ACTIVE_DOC_SESSION_KEY).catch(() => {});
    }
    return;
  }

  const json = JSON.stringify(session);
  storageSet(ACTIVE_DOC_SESSION_KEY, json);
  if (typeof indexedDB !== 'undefined') {
    await set(ACTIVE_DOC_SESSION_KEY, session).catch(() => {});
  }
}

/**
 * Restores the active workspace document session if one was open before page refresh.
 */
export async function loadActiveDocSession(): Promise<ActiveDocSession | null> {
  if (typeof indexedDB !== 'undefined') {
    try {
      const idbSession = await get<ActiveDocSession>(ACTIVE_DOC_SESSION_KEY);
      if (idbSession && idbSession.documentId) return idbSession;
    } catch {
      // fallback below
    }
  }
  try {
    const raw = storageGet(ACTIVE_DOC_SESSION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ActiveDocSession;
      if (parsed && parsed.documentId) return parsed;
    }
  } catch {
    // ignore
  }
  return null;
}
