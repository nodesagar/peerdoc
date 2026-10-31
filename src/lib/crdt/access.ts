import { get, set } from 'idb-keyval';
import { newRoomKey, roomChannel } from './roomKey';
import { sealMessage, openMessage } from './relayTransport';
import type { SyncTransport, PeerMessage } from './docSync';

/**
 * Invite-only rooms without a server.
 *
 * The owner (whoever opened the PDF) signs a roster: the members' public keys and
 * the room key sealed to each of them (ECDH P-256 -> HKDF -> AES-GCM). The room key
 * is what the document's data channel is derived from (see roomChannel), so:
 *  - invite: a one-time token in the link lets its holder knock on a control channel;
 *    the owner's browser admits them by adding them to a newly signed roster.
 *  - remove: the owner rotates the room key and seals it to everyone else. The removed
 *    browser can't decrypt it, so it can't find or read the room any more.
 * Members gossip the newest roster, so anyone online brings a returning member up to
 * date; only the owner can sign one, so nobody can forge their way in.
 *
 * Limits (inherent without a server): the owner's browser must be online for an
 * invitee's first join; a removed person keeps what they already had; a member
 * offline during a removal can sync their own offline edits to the removed person
 * before learning of it; losing the owner's browser storage freezes the member list.
 */

const enc = new TextEncoder();

export const b64u = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const fromB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function fingerprint(text: string): Promise<string> {
  return b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text))).slice(0, 16));
}

const P256 = { namedCurve: 'P-256' } as const;
const ECDSA = { name: 'ECDSA', hash: 'SHA-256' } as const;

// ================= Identity =================

export interface Identity {
  /** Fingerprint of dhPub: how rosters name this browser. */
  memberId: string;
  /** Fingerprint of signPub: names the rooms this browser owns. */
  ownerId: string;
  signPub: string;
  dhPub: string;
  signKey: CryptoKey;
  dhKey: CryptoKey;
}

export async function createIdentity(): Promise<Identity> {
  // Private keys are non-extractable: storable in IndexedDB, never readable by script.
  const sign = await crypto.subtle.generateKey({ name: 'ECDSA', ...P256 }, false, ['sign', 'verify']);
  const dh = await crypto.subtle.generateKey({ name: 'ECDH', ...P256 }, false, ['deriveBits']);
  const signPub = b64u(new Uint8Array(await crypto.subtle.exportKey('raw', sign.publicKey)));
  const dhPub = b64u(new Uint8Array(await crypto.subtle.exportKey('raw', dh.publicKey)));
  return {
    memberId: await fingerprint(dhPub),
    ownerId: await fingerprint(signPub),
    signPub,
    dhPub,
    signKey: sign.privateKey,
    dhKey: dh.privateKey,
  };
}

let identityPromise: Promise<Identity> | null = null;
/** This browser's identity, created once. */
export function getIdentity(): Promise<Identity> {
  identityPromise ??= (async () => {
    try {
      const saved = await get<Identity>('editordoc_identity');
      if (saved?.signKey && saved.dhKey) return saved;
      const fresh = await createIdentity();
      await set('editordoc_identity', fresh);
      return fresh;
    } catch {
      return createIdentity(); // storage blocked: works until the tab closes
    }
  })();
  return identityPromise;
}

// ================= Roster =================

export interface Member {
  id: string;
  dhPub: string;
  label: string;
  inviteId?: string;
  /** Room key for this epoch, sealed to this member. */
  key: string;
}

export interface Roster {
  documentId: string;
  /** Bumped on every change; the highest validly signed version wins. */
  version: number;
  /** Bumped when the room key rotates. */
  epoch: number;
  owner: { signPub: string; dhPub: string };
  members: Member[];
}

/** The JSON is signed as sent, so verifying never depends on re-serialising. */
export interface SignedRoster {
  body: string;
  sig: string;
}

export async function signRoster(roster: Roster, owner: Identity): Promise<SignedRoster> {
  const body = JSON.stringify(roster);
  const sig = await crypto.subtle.sign(ECDSA, owner.signKey, enc.encode(body));
  return { body, sig: b64u(new Uint8Array(sig)) };
}

/** The roster, if it is for this document and signed by this owner; otherwise null. */
export async function verifyRoster(signed: unknown, documentId: string, ownerId: string): Promise<Roster | null> {
  try {
    const { body, sig } = signed as SignedRoster;
    if (typeof body !== 'string' || typeof sig !== 'string') return null;
    const r = JSON.parse(body) as Roster;
    if (r.documentId !== documentId || !Number.isInteger(r.version) || !Array.isArray(r.members)) return null;
    if ((await fingerprint(r.owner.signPub)) !== ownerId) return null;
    const pub = await crypto.subtle.importKey('raw', fromB64u(r.owner.signPub), { name: 'ECDSA', ...P256 }, false, ['verify']);
    return (await crypto.subtle.verify(ECDSA, pub, fromB64u(sig), enc.encode(body))) ? r : null;
  } catch {
    return null;
  }
}

async function pairKey(mine: CryptoKey, theirDhPub: string, info: string): Promise<CryptoKey> {
  const pub = await crypto.subtle.importKey('raw', fromB64u(theirDhPub), { name: 'ECDH', ...P256 }, false, []);
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, mine, 256);
  const ikm = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('editordoc-access-v1'), info: enc.encode(info) },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

const roomKeyInfo = (documentId: string, epoch: number) => `roomkey|${documentId}|${epoch}`;

async function sealRoomKey(owner: Identity, memberDhPub: string, documentId: string, epoch: number, roomKey: string) {
  const key = await pairKey(owner.dhKey, memberDhPub, roomKeyInfo(documentId, epoch));
  return b64u(await sealMessage(key, roomKey));
}

/** The room key sealed to `me` in this roster, or null if I'm not in it. */
export async function openRoomKey(me: Identity, roster: Roster): Promise<string | null> {
  const entry = roster.members.find((m) => m.id === me.memberId);
  if (!entry) return null;
  try {
    const key = await pairKey(me.dhKey, roster.owner.dhPub, roomKeyInfo(roster.documentId, roster.epoch));
    const roomKey = await openMessage(key, fromB64u(entry.key));
    return typeof roomKey === 'string' ? roomKey : null;
  } catch {
    return null;
  }
}

// ================= Invites =================

export interface Invite {
  id: string;
  token: string;
  label: string;
  createdAt: number;
}

/** Public ID (safe to send around) and the key only token holders can derive. */
export async function inviteKeys(token: string): Promise<{ id: string; key: CryptoKey }> {
  const ikm = await crypto.subtle.importKey('raw', enc.encode(token), 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('editordoc-invite-v1'), info: enc.encode('join') },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  return { id: await fingerprint('editordoc-invite-id-v1:' + token), key };
}

export function inviteLink(base: string, documentId: string, ownerId: string, token: string): string {
  const url = new URL(base);
  url.search = new URLSearchParams({ doc: documentId }).toString();
  url.hash = new URLSearchParams({ i: token, o: ownerId }).toString();
  return url.toString();
}

// ================= Per-document record =================

export interface RoomRecord {
  ownerId: string;
  /** Latest roster this browser accepted. */
  roster?: SignedRoster;
  /** Decrypted key of the current epoch; absent while pending or after removal. */
  roomKey?: string;
  /** Invitee: the token we knock with until admitted. */
  token?: string;
  removed?: boolean;
  /** Owner: invites not used yet. */
  invites?: Invite[];
}

export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}
const idbStore: KV = { get, set };
const recordKey = (documentId: string) => `editordoc_room_${documentId}`;

export const loadRoom = (documentId: string, store: KV = idbStore) => store.get<RoomRecord>(recordKey(documentId));
export const saveRoom = (documentId: string, record: RoomRecord, store: KV = idbStore) =>
  store.set(recordKey(documentId), record);

/** A fresh room owned by `owner`, with only the owner in it. */
export async function createOwnedRoom(documentId: string, owner: Identity, store: KV = idbStore): Promise<RoomRecord> {
  const roomKey = newRoomKey();
  const roster: Roster = {
    documentId,
    version: 1,
    epoch: 1,
    owner: { signPub: owner.signPub, dhPub: owner.dhPub },
    members: [{ id: owner.memberId, dhPub: owner.dhPub, label: 'Owner', key: await sealRoomKey(owner, owner.dhPub, documentId, 1, roomKey) }],
  };
  const record: RoomRecord = { ownerId: owner.ownerId, roster: await signRoster(roster, owner), roomKey, invites: [] };
  await saveRoom(documentId, record, store);
  return record;
}

// ================= Live controller =================

export type AccessStatus = 'loading' | 'none' | 'owner' | 'member' | 'pending' | 'removed';

export interface AccessView {
  status: AccessStatus;
  roomKey: string | null;
  ownerId: string | null;
  members: { id: string; label: string; isOwner: boolean; isMe: boolean }[];
  invites: Invite[];
}

export const LOADING_VIEW: AccessView = { status: 'loading', roomKey: null, ownerId: null, members: [], invites: [] };

/** Web Locks keep two owner tabs from signing conflicting rosters. */
function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  return locks ? (locks.request(name, fn) as Promise<T>) : fn();
}

export class RoomAccess {
  private record: RoomRecord | null = null;
  private roster: Roster | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private knockTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private static KNOCK_MS = 4000;

  constructor(
    private readonly o: {
      documentId: string;
      identity: Identity;
      /** Fresh transports for the control channel (not the document's). */
      transports: SyncTransport[];
      onChange: (view: AccessView) => void;
      store?: KV;
    }
  ) {}

  private get store() {
    return this.o.store ?? idbStore;
  }

  private get isOwner() {
    return this.record?.ownerId === this.o.identity.ownerId;
  }

  private get isPending() {
    return !!this.record?.token && !this.record.roomKey && !this.record.removed;
  }

  async start() {
    const { documentId } = this.o;
    this.record = (await loadRoom(documentId, this.store)) ?? null;
    if (this.stopped) return;
    if (!this.record) return this.emit();
    this.roster = await verifyRoster(this.record.roster, documentId, this.record.ownerId);
    if (this.stopped) return;
    this.emit();

    // Everyone who ever knew this owner's room can find this channel, so it only
    // carries signed rosters and join requests sealed to an invite token.
    const channel = roomChannel(documentId, `access-${this.record.ownerId}`);
    for (const t of this.o.transports) {
      t.onPeerJoin((peer) => this.hello(t, peer));
      t.onMessage((peer, msg) => this.handle(t, peer, msg));
      t.connect(channel);
    }
    this.knockTimer = setInterval(() => this.knock(), RoomAccess.KNOCK_MS);
    this.knock();
  }

  stop() {
    this.stopped = true;
    if (this.knockTimer) clearInterval(this.knockTimer);
    this.o.transports.forEach((t) => t.disconnect());
  }

  /** Owner: a one-time invite for one person. Returns its token. */
  createInvite(label: string): Promise<string | null> {
    return this.ownerUpdate(async (_roster, rec) => {
      const token = newRoomKey();
      const { id } = await inviteKeys(token);
      rec.invites = [...(rec.invites ?? []), { id, token, label: label.trim().slice(0, 40) || 'Guest', createdAt: Date.now() }];
      return { token };
    }).then((r) => r?.token ?? null);
  }

  revokeInvite(inviteId: string) {
    return this.ownerUpdate(async (_roster, rec) => {
      rec.invites = (rec.invites ?? []).filter((i) => i.id !== inviteId);
      return {};
    });
  }

  /** Owner: cut a member off by rotating the room key to everyone else. */
  removeMember(memberId: string) {
    return this.ownerUpdate(async (roster, rec) => {
      if (memberId === this.o.identity.memberId) return null;
      const remaining = roster.members.filter((m) => m.id !== memberId);
      if (remaining.length === roster.members.length) return null;
      const epoch = roster.epoch + 1;
      const roomKey = newRoomKey();
      const members = await Promise.all(
        remaining.map(async (m) => ({ ...m, key: await sealRoomKey(this.o.identity, m.dhPub, roster.documentId, epoch, roomKey) }))
      );
      rec.roomKey = roomKey;
      return { roster: { ...roster, epoch, members } };
    });
  }

  // ---------- internals ----------

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * Owner-side read-modify-write of the stored record, under a cross-tab lock.
   * `change` edits `rec` in place and may return a new roster to sign and publish.
   */
  private ownerUpdate(
    change: (roster: Roster, rec: RoomRecord) => Promise<{ roster?: Roster; token?: string } | null>
  ): Promise<{ roster?: Roster; token?: string } | null> {
    const { documentId, identity } = this.o;
    return this.serial(() =>
      withLock(`editordoc-room-${documentId}`, async () => {
        const rec = await loadRoom(documentId, this.store);
        if (!rec || rec.ownerId !== identity.ownerId) return null;
        const roster = await verifyRoster(rec.roster, documentId, rec.ownerId);
        if (!roster) return null;
        const result = await change(roster, rec);
        if (!result) return null;
        let next = roster;
        if (result.roster) {
          next = { ...result.roster, version: roster.version + 1 };
          rec.roster = await signRoster(next, identity);
        }
        await saveRoom(documentId, rec, this.store);
        if (this.stopped) return result;
        this.record = rec;
        this.roster = next;
        this.emit();
        if (result.roster) this.broadcastRoster();
        return result;
      })
    );
  }

  private rosterMessage(): PeerMessage | null {
    return this.record?.roster ? { type: 'roster', payload: this.record.roster } : null;
  }

  private broadcastRoster() {
    const msg = this.rosterMessage();
    if (msg) this.o.transports.forEach((t) => t.broadcast(msg));
  }

  private hello(t: SyncTransport, peer: string) {
    const msg = this.rosterMessage();
    if (msg) t.sendToPeer(peer, msg);
    if (this.isPending) this.joinMessage().then((join) => join && t.sendToPeer(peer, join));
  }

  private async joinMessage(): Promise<PeerMessage | null> {
    const token = this.record?.token;
    if (!token) return null;
    const { id, key } = await inviteKeys(token);
    const box = await sealMessage(key, { dhPub: this.o.identity.dhPub });
    return { type: 'join', payload: { invite: id, box: b64u(box) } };
  }

  /** Pending invitees keep asking until an owner-signed roster lists them. */
  private async knock() {
    if (!this.isPending) return;
    const msg = await this.joinMessage();
    if (msg && !this.stopped) this.o.transports.forEach((t) => t.broadcast(msg));
  }

  private handle(t: SyncTransport, peer: string, msg: PeerMessage) {
    if (this.stopped || !msg) return;
    if (msg.type === 'roster') this.serial(() => this.adopt(msg.payload, t, peer));
    else if (msg.type === 'join' && this.isOwner) this.admit(msg.payload);
  }

  private async adopt(signed: unknown, t: SyncTransport, peer: string) {
    const { documentId, identity } = this.o;
    if (!this.record) return;
    const roster = await verifyRoster(signed, documentId, this.record.ownerId);
    if (!roster || this.stopped) return;
    const current = this.roster?.version ?? 0;
    if (roster.version < current) {
      // They're behind: catch them up
      const mine = this.rosterMessage();
      if (mine) t.sendToPeer(peer, mine);
      return;
    }
    if (roster.version === current) return;

    // Base on the stored record: another tab may have changed it
    const rec: RoomRecord = { ...((await loadRoom(documentId, this.store)) ?? this.record), roster: signed as SignedRoster };
    const wasMember = !!this.record.roomKey || !!this.roster?.members.some((m) => m.id === identity.memberId);
    if (roster.members.some((m) => m.id === identity.memberId)) {
      const roomKey = await openRoomKey(identity, roster);
      if (!roomKey) return; // listed but undecryptable: keep what we have
      rec.roomKey = roomKey;
      rec.removed = false;
      delete rec.token;
    } else {
      delete rec.roomKey;
      if (wasMember) rec.removed = true; // pending invitees just keep waiting
    }
    await saveRoom(documentId, rec, this.store);
    if (this.stopped) return;
    this.record = rec;
    this.roster = roster;
    this.emit();
    this.broadcastRoster(); // gossip: reach peers the sender can't
  }

  private async admit(payload: any) {
    const inviteId = payload?.invite;
    const box = payload?.box;
    if (typeof inviteId !== 'string' || typeof box !== 'string') return;
    if (this.roster?.members.some((m) => m.inviteId === inviteId)) {
      this.broadcastRoster(); // already admitted; they missed the roster
      return;
    }
    await this.ownerUpdate(async (roster, rec) => {
      const invite = rec.invites?.find((i) => i.id === inviteId);
      if (!invite || roster.members.some((m) => m.inviteId === inviteId)) return null;
      let dhPub: unknown;
      try {
        ({ dhPub } = await openMessage((await inviteKeys(invite.token)).key, fromB64u(box)));
      } catch {
        return null; // not sealed with this invite's token
      }
      if (typeof dhPub !== 'string') return null;
      const id = await fingerprint(dhPub);
      rec.invites = rec.invites!.filter((i) => i.id !== inviteId); // one use
      if (roster.members.some((m) => m.id === id)) return {};
      const key = await sealRoomKey(this.o.identity, dhPub, roster.documentId, roster.epoch, rec.roomKey!);
      return { roster: { ...roster, members: [...roster.members, { id, dhPub, label: invite.label, inviteId, key }] } };
    });
  }

  private emit() {
    if (this.stopped) return;
    const rec = this.record;
    const me = this.o.identity.memberId;
    const status: AccessStatus = !rec
      ? 'none'
      : this.isOwner
      ? 'owner'
      : rec.roomKey
      ? 'member'
      : rec.removed
      ? 'removed'
      : 'pending';
    this.o.onChange({
      status,
      roomKey: rec?.roomKey ?? null,
      ownerId: rec?.ownerId ?? null,
      members: (this.roster?.members ?? []).map((m) => ({
        id: m.id,
        label: m.label,
        isOwner: m.dhPub === this.roster!.owner.dhPub,
        isMe: m.id === me,
      })),
      invites: this.isOwner ? rec?.invites ?? [] : [],
    });
  }
}
