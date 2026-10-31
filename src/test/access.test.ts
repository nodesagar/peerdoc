import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  AccessView,
  Identity,
  KV,
  RoomAccess,
  createIdentity,
  createOwnedRoom,
  loadRoom,
  saveRoom,
  signRoster,
  verifyRoster,
  Roster,
} from '../lib/crdt/access';
import { PubSubTransport, PubSubBusFactory } from '../lib/crdt/docSync';
import { parseShareInput } from '../lib/crdt/roomKey';

const WAIT = { timeout: 4000, interval: 10 };
const DOC = 'c'.repeat(64);

// One shared in-memory "network": every bus on a room ID hears every post (JSON, async).
const rooms = new Map<string, Set<(m: any) => void>>();
const memoryBus: PubSubBusFactory = (roomId, onMessage) => {
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  const subs = rooms.get(roomId)!;
  const handler = (m: any) => onMessage(JSON.parse(JSON.stringify(m)));
  subs.add(handler);
  return {
    post: (msg) => subs.forEach((h) => h !== handler && setTimeout(() => h(msg), 0)),
    close: () => subs.delete(handler),
  };
};

const memStore = (): KV => {
  const m = new Map<string, unknown>();
  return { get: async (k) => structuredClone(m.get(k)) as any, set: async (k, v) => void m.set(k, structuredClone(v)) };
};

interface Browser {
  identity: Identity;
  store: KV;
  view: AccessView | null;
  access: RoomAccess | null;
}

const running: RoomAccess[] = [];
afterEach(() => {
  running.splice(0).forEach((a) => a.stop());
  rooms.clear();
});

async function browser(): Promise<Browser> {
  return { identity: await createIdentity(), store: memStore(), view: null, access: null };
}

async function go(b: Browser) {
  b.access?.stop();
  b.access = new RoomAccess({
    documentId: DOC,
    identity: b.identity,
    store: b.store,
    transports: [new PubSubTransport('mem', memoryBus)],
    onChange: (v) => (b.view = v),
  });
  running.push(b.access);
  await b.access.start();
}

function offline(b: Browser) {
  b.access?.stop();
  b.access = null;
}

async function invite(owner: Browser, guest: Browser, label: string) {
  const token = (await owner.access!.createInvite(label))!;
  const link = `https://x.app/?doc=${DOC}#i=${token}&o=${owner.identity.ownerId}`;
  const parsed = parseShareInput(link)!;
  expect(parsed.invite).toEqual({ token, ownerId: owner.identity.ownerId });
  await saveRoom(DOC, { ownerId: parsed.invite!.ownerId, token: parsed.invite!.token }, guest.store);
  return token;
}

describe('invite-only rooms', () => {
  it('admits invitees, removes one by rotating the key, and keeps them out', async () => {
    const owner = await browser();
    const alice = await browser();
    const bob = await browser();
    await createOwnedRoom(DOC, owner.identity, owner.store);
    await go(owner);
    expect(owner.view?.status).toBe('owner');
    const firstKey = owner.view!.roomKey!;

    await invite(owner, alice, 'Alice');
    const bobToken = await invite(owner, bob, 'Bob');
    await go(alice);
    await go(bob);
    expect(bob.view?.status).toBe('pending');

    await vi.waitFor(() => {
      expect(alice.view?.status).toBe('member');
      expect(bob.view?.status).toBe('member');
    }, WAIT);
    expect(alice.view!.roomKey).toBe(firstKey);
    expect(bob.view!.roomKey).toBe(firstKey);
    expect(owner.view!.members.map((m) => m.label)).toEqual(['Owner', 'Alice', 'Bob']);
    expect(owner.view!.invites).toEqual([]); // each invite is used up

    const bobId = bob.identity.memberId;
    await owner.access!.removeMember(bobId);
    await vi.waitFor(() => {
      expect(bob.view?.status).toBe('removed');
      expect(alice.view?.roomKey).toBe(owner.view?.roomKey);
    }, WAIT);
    expect(owner.view!.roomKey).not.toBe(firstKey);
    expect(bob.view!.roomKey).toBeNull();
    expect((await loadRoom(DOC, bob.store))?.roomKey).toBeUndefined();

    // Bob re-using his old invite link gets nowhere
    await saveRoom(DOC, { ownerId: owner.identity.ownerId, token: bobToken }, bob.store);
    await go(bob);
    await new Promise((r) => setTimeout(r, 200));
    expect(owner.view!.members.map((m) => m.label)).toEqual(['Owner', 'Alice']);
    expect(bob.view?.roomKey ?? null).toBeNull();
  });

  it('a cancelled invite admits no one', async () => {
    const owner = await browser();
    const carol = await browser();
    await createOwnedRoom(DOC, owner.identity, owner.store);
    await go(owner);
    await invite(owner, carol, 'Carol');
    await owner.access!.revokeInvite(owner.view!.invites[0].id);
    await go(carol);
    await new Promise((r) => setTimeout(r, 200));
    expect(carol.view?.status).toBe('pending');
    expect(owner.view!.members).toHaveLength(1);
  });

  it('a member who missed a removal catches up from another member, owner offline', async () => {
    const owner = await browser();
    const alice = await browser();
    const bob = await browser();
    const dave = await browser();
    await createOwnedRoom(DOC, owner.identity, owner.store);
    await go(owner);
    for (const [b, name] of [[alice, 'Alice'], [bob, 'Bob'], [dave, 'Dave']] as const) {
      await invite(owner, b, name);
      await go(b);
    }
    await vi.waitFor(() => expect(owner.view!.members).toHaveLength(4), WAIT);
    await vi.waitFor(() => expect(dave.view?.status).toBe('member'), WAIT);

    offline(alice);
    await owner.access!.removeMember(bob.identity.memberId);
    await vi.waitFor(() => expect(dave.view?.roomKey).toBe(owner.view?.roomKey), WAIT);
    const newKey = owner.view!.roomKey;
    offline(owner);

    await go(alice); // only Dave (and removed Bob) are online
    await vi.waitFor(() => expect(alice.view?.roomKey).toBe(newKey), WAIT);
    expect(alice.view!.members.map((m) => m.label)).toEqual(['Owner', 'Alice', 'Dave']);
  });

  it('rejects rosters not signed by the owner', async () => {
    const owner = await browser();
    const mallory = await browser();
    const rec = await createOwnedRoom(DOC, owner.identity, owner.store);
    const ownerId = owner.identity.ownerId;
    expect(await verifyRoster(rec.roster, DOC, ownerId)).not.toBeNull();

    const roster = JSON.parse(rec.roster!.body) as Roster;
    const grab = { ...roster, version: 99, members: [...roster.members, { ...roster.members[0], id: mallory.identity.memberId }] };
    // Signed by someone else, with or without claiming the owner's key
    expect(await verifyRoster(await signRoster(grab, mallory.identity), DOC, ownerId)).toBeNull();
    // Owner's signature over a different body
    expect(await verifyRoster({ body: JSON.stringify(grab), sig: rec.roster!.sig }, DOC, ownerId)).toBeNull();
    // Right owner, wrong document
    expect(await verifyRoster(rec.roster, 'd'.repeat(64), ownerId)).toBeNull();
  });
});
