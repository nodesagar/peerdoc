/**
 * A room = (documentId, roomKey). documentId is the PDF's SHA-256, which anyone
 * holding the same file can compute; the random key is what keeps strangers out.
 * Every transport derives its channel from it. The key is never in a link: the
 * owner seals it to each invited member (access.ts) and rotates it on removal.
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

/** Parses an invite link (?doc=<id>#i=<token>&o=<owner>) or a bare 64-hex document ID. */
export function parseShareInput(
  input: string
): { documentId: string; invite: { token: string; ownerId: string } | null; legacyKey: boolean } | null {
  let id = input.trim();
  let hash = new URLSearchParams();
  try {
    const url = new URL(id);
    id = url.searchParams.get('doc') ?? id;
    hash = new URLSearchParams(url.hash.slice(1));
  } catch {
    /* not a URL */
  }
  id = id.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(id)) return null;
  const token = hash.get('i');
  const ownerId = hash.get('o');
  const valid = (s: string | null): s is string => !!s && /^[A-Za-z0-9_-]{16,}$/.test(s);
  return {
    documentId: id,
    invite: valid(token) && valid(ownerId) ? { token, ownerId } : null,
    // Old "anyone with the link" rooms (#k=) were replaced by invites
    legacyKey: hash.has('k'),
  };
}
