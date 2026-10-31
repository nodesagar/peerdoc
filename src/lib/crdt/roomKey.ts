import { get, set } from 'idb-keyval';

/**
 * A room = (documentId, roomKey). documentId is the PDF's SHA-256, which anyone
 * holding the same file can compute; the random key is what keeps strangers out.
 * It travels only in the share link's #fragment, which browsers never send to
 * servers or trackers, and every transport derives its channel from it.
 */

/** 128-bit random key, base64url. */
export function newRoomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Channel name every transport joins; without the key you land in a different room. */
export function roomChannel(documentId: string, roomKey: string): string {
  return `${documentId}.${roomKey}`;
}

/** Parses a share link (?doc=<id>#k=<key>) or a bare 64-hex document ID. */
export function parseShareInput(input: string): { documentId: string; roomKey: string | null } | null {
  let id = input.trim();
  let key: string | null = null;
  try {
    const url = new URL(id);
    id = url.searchParams.get('doc') ?? id;
    key = new URLSearchParams(url.hash.slice(1)).get('k');
  } catch {
    /* not a URL */
  }
  id = id.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(id)) return null;
  return { documentId: id, roomKey: key && /^[A-Za-z0-9_-]{16,}$/.test(key) ? key : null };
}

const storageKey = (documentId: string) => `editordoc_roomkey_${documentId}`;

export async function getStoredRoomKey(documentId: string): Promise<string | null> {
  try {
    return (await get<string>(storageKey(documentId))) ?? null;
  } catch {
    return null;
  }
}

export async function storeRoomKey(documentId: string, roomKey: string): Promise<void> {
  try {
    await set(storageKey(documentId), roomKey);
  } catch (err) {
    console.warn('Could not persist room key:', err);
  }
}
