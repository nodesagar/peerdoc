import React from 'react';
import * as Y from 'yjs';
import { HardDrive, Users, Download, Upload, Lock, FolderSync, Undo2, Redo2, QrCode } from 'lucide-react';
import { ActiveTool, SyncStatus } from '../types';
import { PresenceAvatars } from './PresenceAvatars';
import type { Awareness } from 'y-protocols/awareness';
import type { PresenceUser } from '../lib/presence';
import type { RoomAccessApi } from '../hooks/useRoomAccess';
import { SharePanel } from './SharePanel';
import { QRSyncModal } from './QRSyncModal';

export interface PresenceProps {
  awareness: Awareness | null;
  user: PresenceUser;
  onRename: (user: PresenceUser) => void;
}

interface CollaborationBarProps {
  activeTool?: ActiveTool;
  documentId: string | null;
  doc?: Y.Doc | null;
  fileName?: string;
  onOpenActiveDoc?: () => void;
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
  activeTool,
  documentId,
  doc = null,
  fileName,
  onOpenActiveDoc,
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
  const [isQRSyncOpen, setIsQRSyncOpen] = React.useState(false);

  if (!documentId) {
    return (
      <div className="flex items-center gap-1.5 text-caption text-graphite px-3 h-9 rounded-full bg-ink/[0.04]">
        <FolderSync className="w-3.5 h-3.5" />
        <span>No document open</span>
      </div>
    );
  }

  if (activeTool === 'dashboard') {
    return (
      <button
        type="button"
        onClick={onOpenActiveDoc}
        title={fileName ? `${fileName} is open. Click to go back to it.` : 'Go back to the open document'}
        className="flex items-center gap-1.5 text-caption font-medium text-ink px-3 h-9 rounded-full bg-mint hover:brightness-95 transition-all"
      >
        <FolderSync className="w-3.5 h-3.5" />
        <span>Back to document</span>
      </button>
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
          <span className="chip bg-mint" title="Collaborators connected to this document right now">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-ink/40"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-ink"></span>
            </span>
            <Users className="w-3.5 h-3.5" />
            <span>
              {peerCount}
              <span className="hidden sm:inline"> online</span>
            </span>
          </span>
        ) : (
          <span className="chip bg-marigold" title="No collaborators connected. Your changes are saved in this browser and sync when someone joins.">
            <HardDrive className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Saved locally</span>
            <span className="sr-only sm:hidden">No collaborators connected, changes saved locally</span>
          </span>
        )}
      </div>

      <PresenceAvatars {...presence} />

      {servingCount > 0 && (
        <span
          className="chip bg-periwinkle shrink-0"
          title="A collaborator asked for the original file; sending it to them now"
        >
          <Upload className="w-3.5 h-3.5 animate-pulse" />
          <span>Sending file{servingCount > 1 ? ` to ${servingCount}` : ''}</span>
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
          title="Redo your last undone edit (Ctrl/Cmd+Shift+Z)"
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
          title={`Document ${documentId}\n${access.status === 'owner' ? 'Invite people or remove access' : 'See who has access'}`}
          aria-label={access.status === 'owner' ? 'Share: invite people or remove access' : 'See who has access'}
        >
          <Lock className="w-3.5 h-3.5" />
          <span className="hidden sm:inline font-mono text-[11px] font-normal text-white/70">{shortDocId}</span>
          <span>{access.status === 'owner' ? 'Share' : 'Access'}</span>
        </button>
        <SharePanel access={access} dialogRef={shareRef} />
      </div>

      {divider}

      {/* Offline Store-and-Forward CDS & QR buttons */}
      <div className="flex items-center shrink-0">
        <button
          type="button"
          onClick={() => setIsQRSyncOpen(true)}
          className="btn btn-ghost h-8 min-w-8 px-2 gap-1.5 text-caption"
          title="Sync via QR code with a nearby device (no internet needed)"
          aria-label="Sync via QR"
        >
          <QrCode className="w-4 h-4" />
          <span className="hidden 2xl:inline">Sync via QR</span>
        </button>

        <button
          onClick={onExportSync}
          className="hidden sm:inline-flex btn btn-ghost h-8 min-w-8 px-2 gap-1.5 text-caption"
          title="Save all changes to a .cdsync file, to carry them to a device that can't connect"
          aria-label="Export sync file (.cdsync)"
        >
          <Download className="w-4 h-4" />
          <span className="hidden 2xl:inline">Export .cdsync</span>
        </button>

        <button
          onClick={() => fileInputRef.current?.click()}
          className="hidden sm:inline-flex btn btn-ghost h-8 min-w-8 px-2 gap-1.5 text-caption"
          title="Apply the changes in a .cdsync file made on another device"
          aria-label="Import sync file (.cdsync)"
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

      <QRSyncModal
        isOpen={isQRSyncOpen}
        onClose={() => setIsQRSyncOpen(false)}
        doc={doc}
        documentId={documentId}
      />
    </div>
  );
};
