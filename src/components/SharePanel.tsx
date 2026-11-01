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

  const row = 'flex items-center gap-2.5 px-4 py-2.5 text-body-sm';
  const iconBtn = 'btn btn-ghost h-8 w-8 px-0';

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="share-title"
      className="m-auto w-[min(460px,calc(100vw-32px))] rounded-3xl bg-white p-0 text-ink shadow-xl backdrop:bg-ink/30 backdrop:backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && dialogRef.current?.close()}
    >
      <div className="p-6 space-y-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="share-title" className="font-serif text-subheading text-ink">Who has access</h2>
            <p className="text-body-sm text-graphite mt-1">
              {isOwner
                ? 'Each link works once, for one person. Removing someone changes the room key for everyone else.'
                : 'Only the owner can invite or remove people.'}
            </p>
          </div>
          <button onClick={() => dialogRef.current?.close()} className={`${iconBtn} -mr-2 -mt-1`} aria-label="Close">
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
              className="field flex-1 min-w-0"
            />
            <button type="submit" className="btn btn-primary h-11 px-4">
              <Link2 className="w-4 h-4" />
              Invite
            </button>
          </form>
        )}
        {copiedId?.startsWith('new:') && (
          <p className="chip bg-mint py-1" role="status">
            <Check className="w-3.5 h-3.5" /> Invite link copied. Send it privately to that person only.
          </p>
        )}

        <ul className="rounded-2xl bg-linen divide-y divide-ash overflow-hidden">
          {access.members.map((m) => (
            <li key={m.id} className={row}>
              {m.isOwner && (
                <span className="w-6 h-6 rounded-full bg-marigold flex items-center justify-center shrink-0">
                  <Crown className="w-3.5 h-3.5" aria-label="Owner" />
                </span>
              )}
              <span className="flex-1 truncate">
                {m.label}
                {m.isMe && <span className="text-graphite"> (you)</span>}
              </span>
              {isOwner && !m.isMe && (
                <button onClick={() => remove(m.id, m.label)} className={`${iconBtn} hover:text-papaya`} aria-label={`Remove ${m.label}`} title="Remove access">
                  <UserMinus className="w-4 h-4" />
                </button>
              )}
            </li>
          ))}
          {access.invites.map((i) => (
            <li key={i.id} className={`${row} text-graphite`}>
              <span className="flex-1 truncate">
                {i.label} <span className="text-caption">· invited, not joined yet</span>
              </span>
              <button onClick={() => copy(i.id, access.inviteLinkFor(i.token))} className={iconBtn} aria-label={`Copy invite link for ${i.label}`} title="Copy invite link">
                {copiedId === i.id ? <Check className="w-4 h-4 text-ink" /> : <Copy className="w-4 h-4" />}
              </button>
              <button onClick={() => access.revokeInvite(i.id)} className={`${iconBtn} hover:text-papaya`} aria-label={`Cancel invite for ${i.label}`} title="Cancel invite">
                <Trash2 className="w-4 h-4" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </dialog>
  );
};
