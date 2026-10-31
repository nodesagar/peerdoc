import React, { useState } from 'react';
import {
  Users,
  Wifi,
  WifiOff,
  Copy,
  Check,
  RefreshCw,
  Upload,
  Share2,
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

function describe(e: TransferLogEntry): { text: string; tone: 'info' | 'ok' | 'warn' } {
  switch (e.kind) {
    case 'requested':
      return { text: `Asked ${e.peers} ${e.peers === 1 ? 'peer' : 'peers'} for the PDF via ${e.routes.join(' + ')}`, tone: 'info' };
    case 'offered':
      return { text: `Request accepted by peer ${e.peer}: sending ${formatBytes(e.bytes)} in ${e.totalChunks} chunks via ${e.route}`, tone: 'ok' };
    case 'unavailable':
      return { text: `Peer ${e.peer} (${e.route}) doesn't have the PDF either; still asking others`, tone: 'warn' };
    case 'verify-failed':
      return { text: `Received data failed verification (${e.reason}); requesting again`, tone: 'warn' };
    case 'received':
      return { text: `PDF received and verified (${formatBytes(e.bytes)})`, tone: 'ok' };
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
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedId, setCopiedId] = useState(false);
  const [isRequesting, setIsRequesting] = useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const syncFileInputRef = React.useRef<HTMLInputElement>(null);

  const cleanId = documentId.trim().toLowerCase();
  const shortId = `${cleanId.slice(0, 8)}...${cleanId.slice(-6)}`;

  const isLocalhost =
    typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

  const handleCopyLink = () => {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('doc', cleanId);
      navigator.clipboard.writeText(url.toString());
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    } catch (e) {
      console.warn('Failed to copy link:', e);
    }
  };

  const handleCopyId = () => {
    try {
      navigator.clipboard.writeText(cleanId);
      setCopiedId(true);
      setTimeout(() => setCopiedId(false), 2000);
    } catch (e) {
      console.warn('Failed to copy ID:', e);
    }
  };

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
    <div className="max-w-[720px] mx-auto px-4 py-12 animate-in fade-in duration-200">
      <div className="bg-white rounded-2xl border border-black/10 shadow-lg p-6 md:p-8 space-y-6 text-center">
        {/* Top Header Badge */}
        <div className="flex items-center justify-center space-x-2">
          {peerCount > 0 ? (
            <span className="inline-flex items-center space-x-1.5 bg-emerald-50 text-emerald-800 text-xs font-semibold px-3 py-1 rounded-full border border-emerald-200 shadow-2xs">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
              <Users className="w-3.5 h-3.5" />
              <span>{peerCount} {peerCount === 1 ? 'Peer Online' : 'Peers Online'}</span>
            </span>
          ) : (
            <span className="inline-flex items-center space-x-1.5 bg-amber-50 text-amber-800 text-xs font-semibold px-3 py-1 rounded-full border border-amber-200 shadow-2xs">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
              </span>
              <WifiOff className="w-3.5 h-3.5 text-amber-600" />
              <span>Searching for Peers...</span>
            </span>
          )}
        </div>

        {/* Dynamic Center Illustration & Status */}
        <div className="space-y-3">
          <div className="relative w-16 h-16 rounded-2xl bg-[#005db2]/10 text-[#005db2] flex items-center justify-center mx-auto shadow-inner">
            {isTransferring ? (
              <Loader2 className="w-8 h-8 animate-spin text-[#005db2]" />
            ) : peerCount > 0 ? (
              <Users className="w-8 h-8 text-[#005db2]" />
            ) : (
              <Wifi className="w-8 h-8 text-[#005db2] animate-pulse" />
            )}
          </div>

          <h2 className="text-xl md:text-2xl font-bold text-[#1a1c1c] tracking-tight">
            {isTransferring
              ? `Transferring Document (${pdfProgress}%)`
              : accepted
              ? 'Request Accepted, Starting Transfer'
              : peerCount > 0
              ? 'Synchronizing with Peer'
              : 'Connecting to Document Room'}
          </h2>

          <p className="text-xs md:text-sm text-[#5f6368] max-w-md mx-auto leading-relaxed">
            {isTransferring
              ? 'Receiving binary PDF chunks directly from your peer over WebRTC. The document will open automatically once verified.'
              : accepted
              ? 'A peer that has the PDF accepted the request. Chunks should start arriving shortly.'
              : onlyRefusals
              ? 'The peers connected so far do not have the PDF. Make sure the person who shared the link still has it open.'
              : peerCount > 0
              ? asked
                ? 'Connected to document peers. Waiting for one that has the PDF to accept the request...'
                : 'Connected to document peers. Requesting the original PDF binary data...'
              : 'Waiting for the document host to connect. Ensure the person who shared this room ID has EditorDoc open in their browser.'}
          </p>
        </div>

        {/* Troubleshooting / Explanation Card when peerCount === 0 */}
        {peerCount === 0 && (
          <div className="bg-amber-50 border border-amber-200/80 rounded-xl p-3.5 text-left text-xs text-amber-900 space-y-2">
            <div className="font-semibold flex items-center space-x-1.5 text-amber-950">
              <Info className="w-4 h-4 text-amber-600 shrink-0" />
              <span>Why is peer discovery waiting?</span>
            </div>
            <ul className="list-disc list-inside space-y-1 text-amber-800 text-[11px] leading-relaxed">
              <li><strong>Host must be active:</strong> The host who uploaded this document must have EditorDoc open in their browser.</li>
              {isLocalhost && (
                <li><strong>Testing between 2 devices?</strong> <code className="bg-amber-100 px-1 py-0.5 rounded text-amber-900 font-mono">localhost</code> only works on this computer. Use your Wi-Fi IP address (e.g. <code className="bg-amber-100 px-1 py-0.5 rounded text-amber-900 font-mono">http://192.168.x.x:3000/?doc=...</code>) or test with another browser window on this machine.</li>
              )}
              <li><strong>Ad-blockers / Firewall:</strong> Brave Shields or ad-blockers can block WebTorrent/WebRTC trackers. Try pausing them or test on the same network.</li>
            </ul>
          </div>
        )}

        {/* Progress Bar (Visible during chunk transfer) */}
        {isTransferring && (
          <div className="max-w-md mx-auto space-y-2">
            <div className="w-full bg-black/5 rounded-full h-3 overflow-hidden p-0.5 border border-black/10">
              <div
                className="bg-[#005db2] h-full rounded-full transition-all duration-300 ease-out"
                style={{ width: `${Math.max(5, pdfProgress)}%` }}
              />
            </div>
            <div className="flex justify-between text-[11px] font-mono text-[#5f6368]">
              <span>Receiving P2P Chunks</span>
              <span className="font-bold text-[#005db2]">{pdfProgress}%</span>
            </div>
          </div>
        )}

        {/* Request / transfer status */}
        {transferLog.length > 0 && (
          <div className="max-w-md mx-auto text-left bg-[#f4f3f2] rounded-xl border border-black/5 p-3 space-y-1.5" aria-live="polite">
            <div className="text-[11px] uppercase tracking-wider font-semibold text-[#5f6368]">PDF request status</div>
            <ul className="space-y-1">
              {transferLog.map((e, i) => {
                const { text, tone } = describe(e);
                const Icon = tone === 'ok' ? (e.kind === 'received' ? CheckCircle2 : Send) : tone === 'warn' ? (e.kind === 'verify-failed' ? XCircle : AlertTriangle) : RefreshCw;
                const color = tone === 'ok' ? 'text-emerald-700' : tone === 'warn' ? 'text-amber-700' : 'text-[#414753]';
                return (
                  <li key={i} className={`flex items-start gap-2 text-[11px] leading-snug ${color}`}>
                    <Icon className="w-3.5 h-3.5 mt-px shrink-0" />
                    <span className="flex-1">{text}</span>
                    <span className="font-mono text-black/40 shrink-0">{new Date(e.at).toLocaleTimeString()}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* Room ID Card & Copy Actions */}
        <div className="bg-[#f4f3f2] rounded-xl p-3 max-w-md mx-auto border border-black/5 space-y-2">
          <div className="text-[11px] uppercase tracking-wider font-semibold text-[#5f6368]">
            Active Room ID (SHA-256)
          </div>
          <div className="flex items-center justify-between bg-white rounded-lg px-3 py-2 border border-black/10 font-mono text-xs text-[#1a1c1c]">
            <span className="truncate mr-2 font-medium" title={cleanId}>
              {shortId}
            </span>
            <div className="flex items-center space-x-1 shrink-0">
              <button
                onClick={handleCopyId}
                className="p-1 hover:bg-black/5 rounded text-[#5f6368] hover:text-[#1a1c1c] transition-colors"
                title="Copy Room ID"
              >
                {copiedId ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
              <button
                onClick={handleCopyLink}
                className="flex items-center space-x-1 bg-[#005db2]/10 hover:bg-[#005db2]/20 text-[#005db2] px-2 py-0.5 rounded text-[11px] font-semibold transition-colors"
                title="Copy Direct Share URL"
              >
                {copiedLink ? <Check className="w-3 h-3 text-emerald-600" /> : <Share2 className="w-3 h-3" />}
                <span>{copiedLink ? 'Copied!' : 'Share Link'}</span>
              </button>
            </div>
          </div>
        </div>

        {/* Action Controls & Instant Fallbacks */}
        <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
          <button
            onClick={handleManualRequest}
            disabled={isRequesting}
            className="inline-flex items-center justify-center space-x-2 bg-[#005db2] hover:bg-[#004a8f] text-white text-xs font-semibold px-4 py-2.5 rounded-xl shadow-2xs transition-all cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRequesting ? 'animate-spin' : ''}`} />
            <span>{isRequesting ? 'Requesting...' : 'Request PDF from Peers'}</span>
          </button>

          {onUploadFile && (
            <>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center justify-center space-x-2 bg-white hover:bg-black/5 text-[#1a1c1c] border border-black/15 text-xs font-semibold px-4 py-2.5 rounded-xl shadow-2xs transition-colors cursor-pointer"
                title="If you already have this PDF file locally, upload it to match the room ID immediately"
              >
                <Upload className="w-3.5 h-3.5 text-emerald-600" />
                <span>Open Matching Local PDF</span>
              </button>
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFilePicked}
                accept="application/pdf"
                className="hidden"
              />
            </>
          )}

          {onImportSync && (
            <>
              <button
                onClick={() => syncFileInputRef.current?.click()}
                className="inline-flex items-center justify-center space-x-2 bg-white hover:bg-black/5 text-[#1a1c1c] border border-black/15 text-xs font-semibold px-4 py-2.5 rounded-xl shadow-2xs transition-colors cursor-pointer"
                title="Import .cdsync file if direct WebRTC cannot connect"
              >
                <FolderSync className="w-3.5 h-3.5 text-[#005db2]" />
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
              className="inline-flex items-center justify-center space-x-1 text-xs text-[#5f6368] hover:text-[#1a1c1c] px-3 py-2 rounded-xl transition-colors cursor-pointer"
            >
              <ArrowLeft className="w-3.5 h-3.5 mr-1" />
              <span>Dashboard</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
