import React, { useState } from 'react';
import { WifiOff, Users, Download, Upload, Copy, Check, Lock, FolderSync, Undo2, Redo2 } from 'lucide-react';
import { SyncStatus } from '../types';
import { PresenceAvatars } from './PresenceAvatars';
import type { Awareness } from 'y-protocols/awareness';
import type { PresenceUser } from '../lib/presence';

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
}

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
}) => {
  const [copied, setCopied] = useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  if (!documentId) {
    return (
      <div className="flex items-center space-x-1.5 text-xs text-[#5f6368] px-3 py-1 bg-black/[0.03] border border-black/5 rounded-full h-[34px]">
        <FolderSync className="w-3.5 h-3.5" />
        <span>No active document</span>
      </div>
    );
  }

  const shortDocId = `${documentId.slice(0, 6)}...${documentId.slice(-4)}`;

  const handleCopyLink = () => {
    // The address bar holds ?doc=<id>#k=<room key>; that is the invite.
    navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onImportSync(file);
      e.target.value = '';
    }
  };

  return (
    <div className="flex items-center flex-nowrap space-x-2 text-xs bg-white/90 backdrop-blur border border-black/10 rounded-xl px-2.5 py-1 shadow-2xs h-[34px] shrink-0">
      {/* Sync / P2P Status Indicator */}
      <div className="flex items-center space-x-1.5 font-medium shrink-0">
        {peerCount > 0 ? (
          <span className="flex items-center space-x-1 text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
            <Users className="w-3.5 h-3.5" />
            <span>{peerCount} {peerCount === 1 ? 'Peer' : 'Peers'}</span>
          </span>
        ) : (
          <span className="flex items-center space-x-1 text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200" title="CRDT changes saved locally in IndexedDB; will sync when peers connect">
            <WifiOff className="w-3.5 h-3.5" />
            <span>Offline (Saved)</span>
          </span>
        )}
      </div>

      <PresenceAvatars {...presence} />

      {servingCount > 0 && (
        <span
          className="flex items-center space-x-1 text-[#005db2] bg-blue-50 px-2 py-0.5 rounded-full border border-blue-200 font-medium shrink-0"
          title="A peer requested the original PDF; it is being sent to them now"
        >
          <Upload className="w-3.5 h-3.5 animate-pulse" />
          <span>Sending PDF{servingCount > 1 ? ` to ${servingCount}` : ''}</span>
        </span>
      )}

      <div className="h-3.5 w-px bg-black/10 shrink-0" />

      {/* Undo / Redo (only this user's edits) */}
      <div className="flex items-center shrink-0">
        <button
          onClick={onUndo}
          disabled={!canUndo}
          aria-label="Undo"
          title="Undo your last edit (Ctrl/Cmd+Z)"
          className="p-1 rounded-md text-[#414753] hover:bg-black/[0.05] disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <Undo2 className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={onRedo}
          disabled={!canRedo}
          aria-label="Redo"
          title="Redo (Ctrl/Cmd+Shift+Z)"
          className="p-1 rounded-md text-[#414753] hover:bg-black/[0.05] disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <Redo2 className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="h-3.5 w-px bg-black/10 shrink-0" />

      {/* Room ID & Share */}
      <div className="flex items-center space-x-1 shrink-0">
        <button
          onClick={handleCopyLink}
          className="flex items-center space-x-1 text-[#414753] hover:text-[#005db2] bg-black/[0.04] hover:bg-[#005db2]/10 px-2 py-0.5 rounded-md transition-colors"
          title={`Private room for document ${documentId}\nClick to copy the invite link. Anyone with this link can view and edit.`}
        >
          <Lock className="w-3 h-3 text-[#005db2]" />
          <span className="font-mono text-[11px] font-semibold">{shortDocId}</span>
          {copied ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3 text-black/40" />}
        </button>
      </div>

      <div className="h-3.5 w-px bg-black/10 shrink-0 hidden sm:block" />

      {/* Offline Store-and-Forward CDS buttons */}
      <div className="flex items-center space-x-1 shrink-0">
        <button
          onClick={onExportSync}
          className="flex items-center space-x-1 text-[#414753] hover:text-[#1a1c1c] hover:bg-black/[0.05] px-2 py-0.5 rounded-md transition-colors"
          title="Export current CRDT state as .cdsync file for air-gapped / offline sync"
        >
          <Download className="w-3 h-3 text-black/60" />
          <span className="hidden md:inline">Export .cdsync</span>
        </button>

        <button
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center space-x-1 text-[#414753] hover:text-[#1a1c1c] hover:bg-black/[0.05] px-2 py-0.5 rounded-md transition-colors"
          title="Import .cdsync file to apply offline peer updates"
        >
          <Upload className="w-3 h-3 text-black/60" />
          <span className="hidden md:inline">Import .cdsync</span>
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
