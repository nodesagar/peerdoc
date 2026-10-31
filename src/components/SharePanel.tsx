import React, { useRef, useState } from 'react';
import { Check, Copy, Crown, Link2, Trash2, UserMinus, X } from 'lucide-react';
import type { RoomAccessApi } from '../hooks/useRoomAccess';

/** Owner: invite people one by one and remove them. Members: see who has access. */
export const SharePanel: React.FC<{ access: RoomAccessApi; dialogRef: React.RefObject<HTMLDialogElement | null> }> = ({
  access,
  dialogRef,
}) => {
  const [label, setLabel] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const isOwner = access.status === 'owner';

  const copy = (id: string, text: string) => {
    navigator.clipboard.writeText(text).catch(() => window.prompt('Copy this invite link:', text));
    setCopiedId(id);
    setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 2000);
  };

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = label.trim();
    if (!name) return inputRef.current?.focus();
    const token = await access.createInvite(name);
    if (token) copy(`new:${token}`, access.inviteLinkFor(token));
    setLabel('');
  };

  const remove = (id: string, name: string) => {
    if (window.confirm(`Remove ${name}? They stop receiving changes right away. Whatever is already in their browser stays there.`)) {
      access.removeMember(id);
    }
  };

  const row = 'flex items-center gap-2 px-3 py-2 text-sm';
  const iconBtn = 'p-1.5 rounded-md text-[#5f6368] hover:bg-black/[0.06] hover:text-[#1a1c1c]';

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="share-title"
      className="m-auto w-[min(440px,calc(100vw-32px))] rounded-2xl border border-black/10 bg-white p-0 text-[#1a1c1c] shadow-xl backdrop:bg-black/30"
      onClick={(e) => e.target === e.currentTarget && dialogRef.current?.close()}
    >
      <div className="p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="share-title" className="text-base font-bold">Who has access</h2>
            <p className="text-xs text-[#5f6368] mt-0.5">
              {isOwner
                ? 'Each link works once, for one person. Removing someone changes the room key for everyone else.'
                : 'Only the owner can invite or remove people.'}
            </p>
          </div>
          <button onClick={() => dialogRef.current?.close()} className={iconBtn} aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        {isOwner && (
          <form onSubmit={invite} className="flex gap-2">
            <input
              ref={inputRef}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Who is this for? e.g. Alice"
              maxLength={40}
              aria-label="Name of the person to invite"
              className="flex-1 min-w-0 rounded-lg border border-black/15 px-3 py-2 text-sm focus:outline-2 focus:outline-[#005db2]"
            />
            <button type="submit" className="inline-flex items-center gap-1.5 rounded-lg bg-[#005db2] px-3 py-2 text-sm font-semibold text-white hover:bg-[#004a8f]">
              <Link2 className="w-4 h-4" />
              Invite
            </button>
          </form>
        )}
        {copiedId?.startsWith('new:') && (
          <p className="text-xs text-emerald-700 flex items-center gap-1" role="status">
            <Check className="w-3.5 h-3.5" /> Invite link copied. Send it privately to that person only.
          </p>
        )}

        <ul className="rounded-xl border border-black/10 divide-y divide-black/5">
          {access.members.map((m) => (
            <li key={m.id} className={row}>
              {m.isOwner && <Crown className="w-3.5 h-3.5 text-amber-600 shrink-0" aria-label="Owner" />}
              <span className="flex-1 truncate">
                {m.label}
                {m.isMe && <span className="text-[#5f6368]"> (you)</span>}
              </span>
              {isOwner && !m.isMe && (
                <button onClick={() => remove(m.id, m.label)} className={`${iconBtn} hover:text-red-700`} aria-label={`Remove ${m.label}`} title="Remove access">
                  <UserMinus className="w-4 h-4" />
                </button>
              )}
            </li>
          ))}
          {access.invites.map((i) => (
            <li key={i.id} className={`${row} text-[#5f6368]`}>
              <span className="flex-1 truncate">
                {i.label} <span className="text-xs">· invited, not joined yet</span>
              </span>
              <button onClick={() => copy(i.id, access.inviteLinkFor(i.token))} className={iconBtn} aria-label={`Copy invite link for ${i.label}`} title="Copy invite link">
                {copiedId === i.id ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
              </button>
              <button onClick={() => access.revokeInvite(i.id)} className={`${iconBtn} hover:text-red-700`} aria-label={`Cancel invite for ${i.label}`} title="Cancel invite">
                <Trash2 className="w-4 h-4" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </dialog>
  );
};
