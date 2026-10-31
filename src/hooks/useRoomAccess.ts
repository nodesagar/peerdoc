import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessView, LOADING_VIEW, RoomAccess, getIdentity, inviteLink } from '../lib/crdt/access';
import { createTransports } from '../lib/crdt/p2pProvider';

export type RoomAccessApi = AccessView & {
  /** Owner: one-time invite link for one person. */
  createInvite: (label: string) => Promise<string | null>;
  inviteLinkFor: (token: string) => string;
  revokeInvite: (inviteId: string) => void;
  removeMember: (memberId: string) => void;
};

/** Who may be in this document's room; `revision` restarts it after the stored record changes. */
export function useRoomAccess(documentId: string | null, revision: number): RoomAccessApi {
  const [view, setView] = useState<AccessView>(LOADING_VIEW);
  const accessRef = useRef<RoomAccess | null>(null);

  useEffect(() => {
    setView(LOADING_VIEW);
    if (!documentId) return;
    let cancelled = false;
    let access: RoomAccess | null = null;
    getIdentity().then((identity) => {
      if (cancelled) return;
      access = new RoomAccess({
        documentId,
        identity,
        transports: createTransports(),
        onChange: (v) => !cancelled && setView(v),
      });
      accessRef.current = access;
      access.start().catch((err) => console.error('Room access failed to start:', err));
    });
    return () => {
      cancelled = true;
      access?.stop();
      if (accessRef.current === access) accessRef.current = null;
    };
  }, [documentId, revision]);

  const createInvite = useCallback(async (label: string) => {
    const token = await accessRef.current?.createInvite(label);
    return token ?? null;
  }, []);
  const inviteLinkFor = useCallback(
    (token: string) => inviteLink(window.location.href, documentId!, view.ownerId!, token),
    [documentId, view.ownerId]
  );
  const revokeInvite = useCallback((id: string) => void accessRef.current?.revokeInvite(id), []);
  const removeMember = useCallback((id: string) => void accessRef.current?.removeMember(id), []);

  return { ...view, createInvite, inviteLinkFor, revokeInvite, removeMember };
}
