import { useEffect, useState } from 'react';
import type { Awareness } from 'y-protocols/awareness';

/**
 * Who is in the room and what they're doing. Ephemeral (y-protocols
 * awareness): never stored in the document, expires 30 s after a peer goes quiet.
 */
export interface PresenceUser {
  name: string;
  color: string;
}

export interface PresenceState {
  user: PresenceUser;
  /** ActiveTool the peer has open. */
  tool?: string;
  /** Pointer over a page, in page-percent coordinates. */
  cursor?: { pageIndex: number; x: number; y: number } | null;
  /** ID of the overlay/box the peer has selected. */
  selection?: string | null;
}

export interface Peer extends PresenceState {
  clientId: number;
}

// Mid-tone colours that stay readable with white text and on white paper.
export const PRESENCE_COLORS = ['#d93025', '#e8710a', '#188038', '#1a73e8', '#9334e6', '#c5221f', '#007b83', '#b06000'];
const ADJECTIVES = ['Amber', 'Brisk', 'Calm', 'Clever', 'Coral', 'Swift', 'Jade', 'Lucky', 'Quiet', 'Sunny', 'Teal', 'Witty'];
const ANIMALS = ['Otter', 'Falcon', 'Lynx', 'Panda', 'Heron', 'Fox', 'Koala', 'Orca', 'Robin', 'Tiger', 'Yak', 'Wren'];
const STORAGE_KEY = 'editordoc_user';
const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)];

/** This browser's display identity; generated once, then remembered. */
export function getLocalUser(): PresenceUser {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved && typeof saved.name === 'string' && typeof saved.color === 'string') return saved;
  } catch {
    /* storage unavailable or corrupt: fall through */
  }
  const user = { name: `${pick(ADJECTIVES)} ${pick(ANIMALS)}`, color: pick(PRESENCE_COLORS) };
  saveLocalUser(user);
  return user;
}

export function saveLocalUser(user: PresenceUser) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
  } catch {
    /* private mode: identity just won't persist */
  }
}

export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
}

const rtf = typeof Intl !== 'undefined' ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }) : null;
export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.round((ts - now) / 1000);
  const [value, unit]: [number, Intl.RelativeTimeFormatUnit] =
    Math.abs(s) < 60 ? [s, 'second'] : Math.abs(s) < 3600 ? [Math.round(s / 60), 'minute']
    : Math.abs(s) < 86400 ? [Math.round(s / 3600), 'hour'] : [Math.round(s / 86400), 'day'];
  return rtf ? rtf.format(value, unit) : new Date(ts).toLocaleString();
}

/** Tooltip text for an item's author, e.g. "Added by Teal Otter · 5 minutes ago". */
export function attributionTitle(item: { createdBy?: string; createdAt?: number }): string | undefined {
  if (!item.createdBy) return undefined;
  return `Added by ${item.createdBy}${item.createdAt ? ` · ${timeAgo(item.createdAt)}` : ''}`;
}

/** Remote peers (not this tab) that have announced a user. */
export function remotePeers(awareness: Awareness): Peer[] {
  const peers: Peer[] = [];
  awareness.getStates().forEach((state, clientId) => {
    if (clientId !== awareness.clientID && state?.user) peers.push({ clientId, ...(state as PresenceState) });
  });
  return peers.sort((a, b) => a.clientId - b.clientId);
}

/**
 * Subscribes to a projection of remote peers; re-renders only when the
 * projection changes (so cursor moves don't re-render avatar lists).
 */
export function usePeers<T>(awareness: Awareness | null, select: (peers: Peer[]) => T): T {
  const read = () => select(awareness ? remotePeers(awareness) : []);
  const [value, setValue] = useState<T>(read);
  useEffect(() => {
    if (!awareness) {
      setValue(read());
      return;
    }
    const initial = read();
    let last = JSON.stringify(initial);
    setValue(initial);
    const onChange = () => {
      const next = read();
      const json = JSON.stringify(next);
      if (json !== last) {
        last = json;
        setValue(next);
      }
    };
    awareness.on('change', onChange);
    return () => awareness.off('change', onChange);
    // select is expected to be a stable function
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awareness]);
  return value;
}
