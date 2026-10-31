import { describe, it, expect } from 'vitest';
import { newRoomKey, parseShareInput, roomChannel } from '../lib/crdt/roomKey';
import { deriveRelayChannel, sealMessage, openMessage } from '../lib/crdt/relayTransport';

const ID = 'a'.repeat(64);

describe('room key', () => {
  it('generates distinct url-safe keys', () => {
    const a = newRoomKey();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(newRoomKey()).not.toBe(a);
  });

  it('parses invite links, bare IDs and rejects junk', () => {
    const token = newRoomKey();
    const owner = newRoomKey();
    expect(parseShareInput(`https://x.app/?doc=${ID.toUpperCase()}#i=${token}&o=${owner}`)).toEqual({
      documentId: ID,
      invite: { token, ownerId: owner },
      legacyKey: false,
    });
    expect(parseShareInput(`https://x.app/?doc=${ID}`)).toEqual({ documentId: ID, invite: null, legacyKey: false });
    expect(parseShareInput(` ${ID} `)).toEqual({ documentId: ID, invite: null, legacyKey: false });
    expect(parseShareInput(`https://x.app/?doc=${ID}#i=short&o=${owner}`)?.invite).toBeNull();
    expect(parseShareInput(`https://x.app/?doc=${ID}#k=${token}`)).toEqual({ documentId: ID, invite: null, legacyKey: true });
    expect(parseShareInput('not-a-room')).toBeNull();
  });

  it('peers with the PDF but without the key cannot read relay traffic', async () => {
    const insider = await deriveRelayChannel(roomChannel(ID, newRoomKey()));
    const outsider = await deriveRelayChannel(roomChannel(ID, newRoomKey()));
    expect(outsider.topic).not.toBe(insider.topic);
    const sealed = await sealMessage(insider.key, { secret: 1 });
    await expect(openMessage(outsider.key, sealed)).rejects.toThrow();
    expect(await openMessage(insider.key, sealed)).toEqual({ secret: 1 });
  });
});
