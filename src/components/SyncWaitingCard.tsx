import React, { useState } from 'react';
import {
  Users,
  Wifi,
  WifiOff,
  RefreshCw,
  Upload,
  FileText,
  Loader2,
  ArrowLeft,
  Info,
  FolderSync,
  CheckCircle2,
  XCircle,
  Send,
  AlertTriangle,
} from 'lucide-react';
import type { TransferLogEntry } from '../hooks/useCRDTSync';
import { formatBytes } from '../utils/pdfProcessor';
import { OPEN_ACCEPT } from '../lib/formats';

function describe(e: TransferLogEntry): { text: string; tone: 'info' | 'ok' | 'warn' } {
  switch (e.kind) {
    case 'requested':
      return { text: `Asked ${e.peers} ${e.peers === 1 ? 'peer' : 'peers'} for the file via ${e.routes.join(' + ')}`, tone: 'info' };
    case 'offered':
      return { text: `Request accepted by peer ${e.peer}: sending ${formatBytes(e.bytes)} in ${e.totalChunks} chunks via ${e.route}`, tone: 'ok' };
    case 'unavailable':
      return { text: `Peer ${e.peer} (${e.route}) doesn't have the file either; still asking others`, tone: 'warn' };
    case 'verify-failed':
      return { text: `Received data failed verification (${e.reason}); requesting again`, tone: 'warn' };
    case 'received':
      return { text: `File received and verified (${formatBytes(e.bytes)})`, tone: 'ok' };
    default:
      return { text: '', tone: 'info' };
  }
}

interface SyncWaitingCardProps {
  documentId: string;
  peerCount: number;
  pdfProgress: number | null;
  syncStatus?: string;
  transferLog?: TransferLogEntry[];
  onRequestPdf?: () => void;
  onUploadFile?: (file: File) => void;
  onImportSync?: (file: File) => void;
  onReturnToDashboard?: () => void;
}

export const SyncWaitingCard: React.FC<SyncWaitingCardProps> = ({
  documentId,
  peerCount,
  pdfProgress,
  transferLog = [],
  onRequestPdf,
  onUploadFile,
  onImportSync,
  onReturnToDashboard,
}) => {
  const [isRequesting, setIsRequesting] = useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const syncFileInputRef = React.useRef<HTMLInputElement>(null);

  const cleanId = documentId.trim().toLowerCase();
  const shortId = `${cleanId.slice(0, 8)}...${cleanId.slice(-6)}`;

  const isLocalhost =
    typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

  const handleManualRequest = () => {
    setIsRequesting(true);
    onRequestPdf?.();
    setTimeout(() => setIsRequesting(false), 1500);
  };

  const handleFilePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && onUploadFile) {
      onUploadFile(file);
      e.target.value = '';
    }
  };

  const handleSyncFilePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && onImportSync) {
      onImportSync(file);
      e.target.value = '';
    }
  };

  const isTransferring = pdfProgress !== null && pdfProgress >= 0;
  const accepted = transferLog.some((e) => e.kind === 'offered');
  const asked = transferLog.some((e) => e.kind === 'requested');
  // Only discouraging if the latest news is a refusal (not a newer request)
  const onlyRefusals = !accepted && transferLog.at(-1)?.kind === 'unavailable';

  return (
    <div className="max-w-[720px] mx-auto px-4 py-14">
      <div className="bg-white rounded-3xl shadow-xl p-6 md:p-10 space-y-7 text-center">
        {/* Top Header Badge */}
        <div className="flex items-center justify-center">
          {peerCount > 0 ? (
            <span className="chip bg-mint py-1 px-3">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-ink/40"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-ink"></span>
              </span>
              <Users className="w-3.5 h-3.5" />
              <span>{peerCount} {peerCount === 1 ? 'Peer Online' : 'Peers Online'}</span>
            </span>
          ) : (
            <span className="chip bg-marigold py-1 px-3">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-ink/40"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-ink"></span>
              </span>
              <WifiOff className="w-3.5 h-3.5" />
              <span>Searching for Peers...</span>
            </span>
          )}
        </div>

        {/* Dynamic Center Illustration & Status */}
        <div className="space-y-4">
          <div className="relative w-16 h-16 rounded-2xl bg-periwinkle text-ink flex items-center justify-center mx-auto">
            {isTransferring ? (
              <Loader2 className="w-8 h-8 animate-spin" />
            ) : peerCount > 0 ? (
              <Users className="w-8 h-8" />
            ) : (
              <Wifi className="w-8 h-8 animate-pulse" />
            )}
          </div>

          <h2 className="font-serif text-subheading md:text-heading-sm text-ink text-balance">
            {isTransferring
              ? `Transferring Document (${pdfProgress}%)`
              : accepted
              ? 'Request Accepted, Starting Transfer'
              : peerCount > 0
              ? 'Synchronizing with Peer'
              : 'Connecting to Document Room'}
          </h2>

          <p className="text-body-sm md:text-body text-graphite max-w-md mx-auto">
            {isTransferring
              ? 'Receiving file chunks directly from your peer over WebRTC. The document will open automatically once verified.'
              : accepted
              ? 'A peer that has the file accepted the request. Chunks should start arriving shortly.'
              : onlyRefusals
              ? 'The peers connected so far do not have the file. Make sure the person who shared the link still has it open.'
              : peerCount > 0
              ? asked
                ? 'Connected to document peers. Waiting for one that has the file to accept the request...'
                : 'Connected to document peers. Requesting the original file...'
              : 'Waiting for the document host to connect. Ensure the person who shared this link has EditorDoc open in their browser.'}
          </p>
        </div>

        {/* Troubleshooting / Explanation Card when peerCount === 0 */}
        {peerCount === 0 && (
          <div className="bg-marigold/45 rounded-2xl p-4 md:p-5 text-left text-body-sm text-ink space-y-2">
            <div className="font-semibold flex items-center gap-2">
              <Info className="w-4 h-4 shrink-0" />
              <span>Why is peer discovery waiting?</span>
            </div>
            <ul className="list-disc list-inside space-y-1 text-graphite text-caption">
              <li><strong className="text-ink">Host must be active:</strong> The host who uploaded this document must have EditorDoc open in their browser.</li>
              {isLocalhost && (
                <li><strong className="text-ink">Testing between 2 devices?</strong> <code className="bg-white/70 px-1 py-0.5 rounded-md text-ink font-mono">localhost</code> only works on this computer. Use your Wi-Fi IP address (e.g. <code className="bg-white/70 px-1 py-0.5 rounded-md text-ink font-mono">http://192.168.x.x:3000/?doc=...</code>) or test with another browser window on this machine.</li>
              )}
              <li><strong className="text-ink">Ad-blockers / Firewall:</strong> Brave Shields or ad-blockers can block WebTorrent/WebRTC trackers. Try pausing them or test on the same network.</li>
            </ul>
          </div>
        )}

        {/* Progress Bar (Visible during chunk transfer) */}
        {isTransferring && (
          <div className="max-w-md mx-auto space-y-2">
            <div className="w-full bg-cloud rounded-full h-2.5 overflow-hidden">
              <div
                className="bg-ink h-full rounded-full transition-all duration-300 ease-out"
                style={{ width: `${Math.max(5, pdfProgress)}%` }}
              />
            </div>
            <div className="flex justify-between text-caption text-graphite tabular-nums">
              <span>Receiving P2P Chunks</span>
              <span className="font-semibold text-ink">{pdfProgress}%</span>
            </div>
          </div>
        )}

        {/* Request / transfer status */}
        {transferLog.length > 0 && (
          <div className="max-w-md mx-auto text-left bg-linen rounded-2xl p-4 space-y-2" aria-live="polite">
            <div className="eyebrow">File request status</div>
            <ul className="space-y-1.5">
              {transferLog.map((e, i) => {
                const { text, tone } = describe(e);
                const Icon = tone === 'ok' ? (e.kind === 'received' ? CheckCircle2 : Send) : tone === 'warn' ? (e.kind === 'verify-failed' ? XCircle : AlertTriangle) : RefreshCw;
                const color = tone === 'warn' ? 'text-papaya' : tone === 'ok' ? 'text-ink' : 'text-graphite';
                return (
                  <li key={i} className={`flex items-start gap-2 text-caption ${tone === 'info' ? 'text-graphite' : 'text-ink'}`}>
                    <Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${color}`} />
                    <span className="flex-1">{text}</span>
                    <span className="text-graphite/70 tabular-nums shrink-0">{new Date(e.at).toLocaleTimeString()}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* Room ID Card */}
        <div className="bg-linen rounded-2xl p-4 max-w-md mx-auto space-y-2">
          <div className="eyebrow">
            Document ID (SHA-256)
          </div>
          <div className="flex items-center justify-between bg-white rounded-xl px-3 py-2 ring-1 ring-ash font-mono text-caption text-ink">
            <span className="truncate mr-2 font-medium" title={cleanId}>
              {shortId}
            </span>
          </div>
        </div>

        {/* Action Controls & Instant Fallbacks */}
        <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
          <button
            onClick={handleManualRequest}
            disabled={isRequesting}
            className="btn btn-primary"
          >
            <RefreshCw className={`w-4 h-4 ${isRequesting ? 'animate-spin' : ''}`} />
            <span>{isRequesting ? 'Requesting...' : 'Request file from peers'}</span>
          </button>

          {onUploadFile && (
            <>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="btn btn-secondary"
                title="If you already have this file locally, upload it to match the room ID immediately"
              >
                <Upload className="w-4 h-4" />
                <span>Open matching local file</span>
              </button>
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFilePicked}
                accept={OPEN_ACCEPT}
                className="hidden"
              />
            </>
          )}

          {onImportSync && (
            <>
              <button
                onClick={() => syncFileInputRef.current?.click()}
                className="btn btn-secondary"
                title="Import .cdsync file if direct WebRTC cannot connect"
              >
                <FolderSync className="w-4 h-4" />
                <span>Import .cdsync File</span>
              </button>
              <input
                type="file"
                ref={syncFileInputRef}
                onChange={handleSyncFilePicked}
                accept=".cdsync,application/x-cdsync,application/json"
                className="hidden"
              />
            </>
          )}

          {onReturnToDashboard && (
            <button
              onClick={onReturnToDashboard}
              className="btn btn-ghost"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>Dashboard</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
