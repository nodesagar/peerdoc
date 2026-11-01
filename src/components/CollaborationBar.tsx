import React from 'react';
import { WifiOff, Users, Download, Upload, Lock, FolderSync, Undo2, Redo2 } from 'lucide-react';
import { SyncStatus } from '../types';
import { PresenceAvatars } from './PresenceAvatars';
import type { Awareness } from 'y-protocols/awareness';
import type { PresenceUser } from '../lib/presence';
import type { RoomAccessApi } from '../hooks/useRoomAccess';
import { SharePanel } from './SharePanel';

export interface PresenceProps {
  awareness: Awareness | null;
  user: PresenceUser;
  onRename: (user: PresenceUser) => void;
}

interface CollaborationBarProps {
  documentId: string | null;
  syncStatus: SyncStatus;
  peerCount: number;
  servingCount?: number;
  onExportSync: () => void;
  onImportSync: (file: File) => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  presence: PresenceProps;
  access: RoomAccessApi;
}

const divider = <div className="h-4 w-px bg-ink/10 shrink-0 hidden sm:block" />;
const iconBtn = 'btn btn-ghost h-8 w-8 px-0';

export const CollaborationBar: React.FC<CollaborationBarProps> = ({
  documentId,
  syncStatus,
  peerCount,
  servingCount = 0,
  onExportSync,
  onImportSync,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  presence,
  access,
}) => {
  const shareRef = React.useRef<HTMLDialogElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  if (!documentId) {
    return (
      <div className="flex items-center gap-1.5 text-caption text-graphite px-3 h-9 rounded-full bg-ink/[0.04]">
        <FolderSync className="w-3.5 h-3.5" />
        <span>No active document</span>
      </div>
    );
  }

  const shortDocId = `${documentId.slice(0, 6)}...${documentId.slice(-4)}`;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onImportSync(file);
      e.target.value = '';
    }
  };

  return (
    <div className="flex items-center flex-nowrap gap-1 sm:gap-1.5 text-caption h-9 shrink-0">
      {/* Sync / P2P Status Indicator */}
      <div className="flex items-center shrink-0">
        {peerCount > 0 ? (
          <span className="chip bg-mint">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-ink/40"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-ink"></span>
            </span>
            <Users className="w-3.5 h-3.5" />
            <span>
              {peerCount}
              <span className="hidden sm:inline"> {peerCount === 1 ? 'Peer' : 'Peers'}</span>
            </span>
          </span>
        ) : (
          <span className="chip bg-marigold" title="CRDT changes saved locally in IndexedDB; will sync when peers connect">
            <WifiOff className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Offline (Saved)</span>
            <span className="sr-only sm:hidden">Offline, changes saved</span>
          </span>
        )}
      </div>

      <PresenceAvatars {...presence} />

      {servingCount > 0 && (
        <span
          className="chip bg-periwinkle shrink-0"
          title="A peer requested the original PDF; it is being sent to them now"
        >
          <Upload className="w-3.5 h-3.5 animate-pulse" />
          <span>Sending PDF{servingCount > 1 ? ` to ${servingCount}` : ''}</span>
        </span>
      )}

      {divider}

      {/* Undo / Redo (only this user's edits) */}
      <div className="flex items-center shrink-0">
        <button
          onClick={onUndo}
          disabled={!canUndo}
          aria-label="Undo"
          title="Undo your last edit (Ctrl/Cmd+Z)"
          className={iconBtn}
        >
          <Undo2 className="w-4 h-4" />
        </button>
        <button
          onClick={onRedo}
          disabled={!canRedo}
          aria-label="Redo"
          title="Redo (Ctrl/Cmd+Shift+Z)"
          className={iconBtn}
        >
          <Redo2 className="w-4 h-4" />
        </button>
      </div>

      {divider}

      {/* Room ID & Share */}
      <div className="flex items-center shrink-0">
        <button
          onClick={() => shareRef.current?.showModal()}
          className="btn btn-primary h-8 px-3 gap-1.5 text-caption"
          title={`Invite-only room for document ${documentId}\nInvite people or remove access`}
          aria-label="Share: invite people or remove access"
        >
          <Lock className="w-3.5 h-3.5" />
          <span className="hidden sm:inline font-mono text-[11px] font-normal text-white/70">{shortDocId}</span>
          <span>{access.status === 'owner' ? 'Share' : 'Access'}</span>
        </button>
        <SharePanel access={access} dialogRef={shareRef} />
      </div>

      {divider}

      {/* Offline Store-and-Forward CDS buttons (in the header menu on phones) */}
      <div className="hidden sm:flex items-center shrink-0">
        <button
          onClick={onExportSync}
          className="btn btn-ghost h-8 min-w-8 px-2 gap-1.5 text-caption"
          title="Export current CRDT state as .cdsync file for air-gapped / offline sync"
          aria-label="Export .cdsync"
        >
          <Download className="w-4 h-4" />
          <span className="hidden 2xl:inline">Export .cdsync</span>
        </button>

        <button
          onClick={() => fileInputRef.current?.click()}
          className="btn btn-ghost h-8 min-w-8 px-2 gap-1.5 text-caption"
          title="Import .cdsync file to apply offline peer updates"
          aria-label="Import .cdsync"
        >
          <Upload className="w-4 h-4" />
          <span className="hidden 2xl:inline">Import .cdsync</span>
        </button>
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileChange}
          accept=".cdsync,application/x-cdsync,application/json"
          className="hidden"
        />
      </div>
    </div>
  );
};
