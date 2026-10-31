import React, { useState } from 'react';
import { Wifi, WifiOff, Users, Download, Upload, Copy, Check, Share2, Shield, FolderSync } from 'lucide-react';
import { SyncStatus } from '../types';

interface CollaborationBarProps {
  documentId: string | null;
  syncStatus: SyncStatus;
  peerCount: number;
  servingCount?: number;
  onExportSync: () => void;
  onImportSync: (file: File) => void;
}

export const CollaborationBar: React.FC<CollaborationBarProps> = ({
  documentId,
  syncStatus,
  peerCount,
  servingCount = 0,
  onExportSync,
  onImportSync,
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
    const url = new URL(window.location.href);
    url.searchParams.set('doc', documentId);
    navigator.clipboard.writeText(url.toString());
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

      {/* Room ID & Share */}
      <div className="flex items-center space-x-1 shrink-0">
        <button
          onClick={handleCopyLink}
          className="flex items-center space-x-1 text-[#414753] hover:text-[#005db2] bg-black/[0.04] hover:bg-[#005db2]/10 px-2 py-0.5 rounded-md transition-colors"
          title={`Document Room ID: ${documentId}\nClick to copy collaboration link`}
        >
          <Share2 className="w-3 h-3 text-[#005db2]" />
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
