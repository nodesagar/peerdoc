import React from 'react';
import type { Awareness } from 'y-protocols/awareness';
import { initials, usePeers, PresenceUser } from '../lib/presence';

const TOOL_LABELS: Record<string, string> = {
  dashboard: 'on the dashboard',
  edit: 'editing text',
  organize: 'organizing pages',
  redact: 'redacting',
  sign: 'signing',
  compress: 'compressing',
};

const MAX_SHOWN = 4;
const selectPeers = (peers: { clientId: number; user: PresenceUser; tool?: string }[]) =>
  peers.map(({ clientId, user, tool }) => ({ clientId, user, tool }));

interface PresenceAvatarsProps {
  awareness: Awareness | null;
  user: PresenceUser;
  onRename: (user: PresenceUser) => void;
}

/** You + everyone else in the room, with what they're doing. */
export const PresenceAvatars: React.FC<PresenceAvatarsProps> = ({ awareness, user, onRename }) => {
  const peers = usePeers(awareness, selectPeers);
  const hidden = peers.length - MAX_SHOWN;

  const rename = () => {
    const name = window.prompt('Your name (shown to collaborators):', user.name)?.trim();
    if (name && name !== user.name) onRename({ ...user, name: name.slice(0, 40) });
  };

  const dot = (u: PresenceUser) => ({ backgroundColor: u.color });
  const base =
    'w-7 h-7 rounded-full text-[11px] font-semibold text-white flex items-center justify-center ring-2 ring-white shrink-0';

  return (
    <div className="flex items-center -space-x-1.5 shrink-0" aria-label={`${peers.length + 1} ${peers.length === 0 ? 'person' : 'people'} in this room`}>
      <button
        onClick={rename}
        className={`${base} hover:scale-110 transition-transform`}
        style={dot(user)}
        title={`You: ${user.name} (click to rename)`}
        aria-label={`You are ${user.name}. Rename`}
      >
        {initials(user.name)}
      </button>
      {peers.slice(0, MAX_SHOWN).map((p) => (
        <span
          key={p.clientId}
          className={base}
          style={dot(p.user)}
          title={`${p.user.name}${p.tool && TOOL_LABELS[p.tool] ? `: ${TOOL_LABELS[p.tool]}` : ''}`}
          role="img"
          aria-label={p.user.name}
        >
          {initials(p.user.name)}
        </span>
      ))}
      {hidden > 0 && (
        <span
          className={`${base} bg-graphite`}
          title={peers.slice(MAX_SHOWN).map((p) => p.user.name).join(', ')}
        >
          +{hidden}
        </span>
      )}
    </div>
  );
};
