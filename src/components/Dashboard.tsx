import React, { useState } from 'react';
import { ActiveTool, DocAction, ProcessedDoc } from '../types';
import {
  PenTool,
  Layers,
  EyeOff,
  Edit3,
  Minimize2,
  ArrowRight,
  FileText,
  Clock,
  Download,
  SplitSquareHorizontal as Scissors,
  Upload,
} from 'lucide-react';
import { pressable } from '../lib/pressable';
import { OPEN_ACCEPT } from '../lib/formats';
import { formatDateTime, formatTimeAgo, inferFormatFromName } from '../lib/recentDocs';

interface DashboardProps {
  setActiveTool: (tool: ActiveTool) => void;
  recentDocs: ProcessedDoc[];
  onSelectRecentDoc: (doc: ProcessedDoc) => void;
  onOpenRecentDoc?: (doc: ProcessedDoc) => void;
  onLoadSample: () => void;
  onUploadNewDoc: (file: File) => void;
  onJoinRoomId: (roomId: string, preferredTool?: ActiveTool) => void;
  onNewWordDoc: () => void;
  activeDocId: string | null;
}

const ACTION_BADGE_CLASS: Record<DocAction, string> = {
  Opened: 'bg-cloud text-ink',
  Edited: 'bg-mint text-ink',
  'AI Edited': 'bg-mint text-ink',
  Organized: 'bg-periwinkle text-ink',
  Redacted: 'bg-marigold text-ink',
  Signed: 'bg-sky text-ink',
  Compressed: 'bg-mint text-ink',
  Merged: 'bg-periwinkle text-ink',
  Split: 'bg-periwinkle text-ink',
  Watermarked: 'bg-sky text-ink',
  Converted: 'bg-mint text-ink',
  Encrypted: 'bg-marigold text-ink',
};

const TOOL_CARDS = [
  {
    tool: 'edit' as ActiveTool,
    title: 'Edit Text & Erase',
    text: 'Add text to a page or cover content with whiteout.',
    cta: 'Open Editor',
    Icon: Edit3,
    tile: 'bg-mint',
    frame: 'hover:ring-mint',
  },
  {
    tool: 'organize' as ActiveTool,
    title: 'Organize & Reorder',
    text: 'Reorder pages, rotate them, or remove the ones you don’t need.',
    cta: 'Organize Pages',
    Icon: Layers,
    tile: 'bg-periwinkle',
    frame: 'hover:ring-periwinkle',
  },
  {
    tool: 'redact' as ActiveTool,
    title: 'Redact Sensitive Info',
    text: 'Black out private details and remove document metadata.',
    cta: 'Redact Content',
    Icon: EyeOff,
    tile: 'bg-marigold',
    frame: 'hover:ring-marigold',
  },
  {
    tool: 'sign' as ActiveTool,
    title: 'Sign Document',
    text: 'Draw or add a signature, then place it on the page.',
    cta: 'Sign PDF',
    Icon: PenTool,
    tile: 'bg-sky',
    frame: 'hover:ring-sky',
  },
  {
    tool: 'compress' as ActiveTool,
    title: 'Compress',
    text: 'Reduce image-heavy PDFs while keeping text legible.',
    cta: 'Compress PDF',
    Icon: Minimize2,
    tile: 'bg-mint',
    frame: 'hover:ring-mint',
  },
  {
    tool: 'merge' as ActiveTool,
    title: 'Merge Documents',
    text: 'Combine multiple files into a single master PDF with seamless client-side page copying.',
    cta: 'Merge Files',
    Icon: Scissors,
    iconClass: 'rotate-90',
    tile: 'bg-periwinkle',
    frame: 'hover:ring-periwinkle',
  },
];

export const Dashboard: React.FC<DashboardProps> = ({
  setActiveTool,
  recentDocs,
  onSelectRecentDoc,
  onOpenRecentDoc,
  onLoadSample,
  onUploadNewDoc,
  onJoinRoomId,
  onNewWordDoc,
  activeDocId,
}) => {
  const [joinInput, setJoinInput] = useState('');
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const handleJoinSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (joinInput.trim()) {
      onJoinRoomId(joinInput.trim());
      setJoinInput('');
    }
  };

  const handleFilePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onUploadNewDoc(file);
      e.target.value = '';
    }
  };

  return (
    <div className="pb-24 space-y-16 md:space-y-24">
      {/* Hero: clear primary action with room joining as a secondary path */}
      <section className="relative isolate overflow-hidden mx-2 md:mx-3 mt-[calc(4px-var(--header-h))] rounded-4xl sky-paper">
        <div className="relative mx-auto max-w-3xl px-5 pb-10 pt-[calc(var(--header-h)+56px)] text-center sm:pb-12 md:pt-[calc(var(--header-h)+72px)]">
          <h1 className="font-serif text-heading-sm font-normal text-ink sm:text-heading md:text-display">
            Peer-to-peer document
            <br />
            editing, offline-first.
          </h1>

          <p className="mx-auto mt-5 max-w-2xl text-pretty text-body text-graphite md:text-lg">
            Edit, sign, redact, and organize any document entirely on your device—then collaborate directly with peers in encrypted rooms{' '}
            <mark className="rounded-md bg-marigold px-2 py-0.5 font-medium text-ink">
              with zero central servers
            </mark>
            .
          </p>

          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="btn btn-primary h-12 w-full px-6 text-body sm:w-auto"
            >
              <Upload className="w-4 h-4" />
              <span>Open a file</span>
            </button>
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFilePicked}
              accept={OPEN_ACCEPT}
              className="hidden"
            />

            <button
              onClick={onNewWordDoc}
              className="btn btn-secondary h-12 w-full px-6 text-body sm:w-auto"
            >
              <FileText className="w-4 h-4" />
              <span>New document</span>
            </button>

            <button
              onClick={onLoadSample}
              className="btn btn-secondary h-12 w-full px-6 text-body sm:w-auto"
            >
              <FileText className="w-4 h-4" />
              <span>Try a sample document</span>
            </button>
          </div>

          <div className="mx-auto mt-8 max-w-xl border-t border-ink/10 pt-6">
            <form onSubmit={handleJoinSubmit} className="flex flex-col items-stretch gap-2 text-left sm:flex-row sm:items-end">
              <div className="min-w-0 flex-1">
                <label htmlFor="join-room" className="mb-1.5 block text-caption font-medium text-graphite">
                  Joining someone? Enter their room link or ID.
                </label>
                <input
                  id="join-room"
                  type="text"
                  placeholder="Paste room link or ID"
                  value={joinInput}
                  onChange={(e) => setJoinInput(e.target.value)}
                  className="field h-11 bg-white/90"
                />
              </div>
              <button
                type="submit"
                disabled={!joinInput.trim()}
                className="btn btn-secondary h-11 px-5 sm:mb-0"
              >
                Join room
              </button>
            </form>
          </div>

          {activeDocId && (
            <p className="mt-5 text-caption text-graphite">
              Current document ID{' '}
              <span title={activeDocId} className="rounded-md bg-white/70 px-2 py-0.5 font-mono font-medium text-ink">
                {activeDocId.slice(0, 12)}...
              </span>
            </p>
          )}
        </div>
      </section>

      {/* Primary Tools Grid */}
      <div className="max-w-[1280px] mx-auto px-4 md:px-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {TOOL_CARDS.map(({ tool, title, text, cta, Icon, iconClass, tile, frame }) => (
          <div
            key={tool}
            {...pressable(() => setActiveTool(tool))}
            className={`group relative bg-white rounded-3xl p-6 shadow-xl hover:ring-4 hover:-translate-y-1 transition-[box-shadow,translate] duration-300 flex flex-col justify-between ${frame}`}
          >
            <div className="space-y-3">
              <div className="pb-1">
                <div className={`flex size-12 items-center justify-center rounded-2xl ${tile} text-ink`}>
                  <Icon className={`w-5 h-5 ${iconClass ?? ''}`} />
                </div>
              </div>
              <h3 className="text-xl font-semibold tracking-[-0.4px] text-ink">{title}</h3>
              <p className="text-body-sm text-graphite">{text}</p>
            </div>
            <div className="pt-5 flex items-center gap-1.5 text-body-sm font-medium text-ink">
              <span>{cta}</span>
              <ArrowRight className="w-4 h-4 transition-transform duration-300 group-hover:translate-x-1" />
            </div>
          </div>
        ))}
      </div>

      {/* Recent Documents History */}
      <div className="max-w-[1280px] mx-auto px-4 md:px-8">
        <div className="bg-white rounded-3xl shadow-xl p-6 md:p-8 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ash pb-5">
            <div className="flex items-center gap-3">
              <span className="w-10 h-10 rounded-full bg-linen text-ink flex items-center justify-center shrink-0">
                <Clock className="w-[18px] h-[18px]" />
              </span>
              <h2 className="font-serif text-subheading text-ink">Recent Documents</h2>
              <span className="text-caption text-graphite tabular-nums">({recentDocs.length})</span>
            </div>
            <span className="text-caption text-graphite">
              Persisted locally until browser cache is cleared
            </span>
          </div>

          {recentDocs.length === 0 ? (
            <div className="text-center py-10 text-body-sm text-graphite">
              No recent documents yet. Open a PDF or Word document, or load the demo agreement above!
            </div>
          ) : (
            <div className="overflow-x-auto -mx-2 px-2">
              <table className="w-full text-left border-collapse" aria-label="Recent documents">
                <thead>
                  <tr className="border-b border-ash text-caption font-semibold text-graphite">
                    <th scope="col" className="py-3 pr-4 pl-2">Document</th>
                    <th scope="col" className="py-3 px-4">Activity &amp; Details</th>
                    <th scope="col" className="py-3 px-4">Size</th>
                    <th scope="col" className="py-3 px-4">Room ID</th>
                    <th scope="col" className="py-3 px-4">Last Worked</th>
                    <th scope="col" className="py-3 pl-4 pr-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ash">
                  {recentDocs.map((doc) => {
                    const fmt = (doc.format ?? inferFormatFromName(doc.name) ?? 'pdf').toUpperCase();
                    const isActive = Boolean(activeDocId && doc.documentId && doc.documentId === activeDocId);
                    const badgeClass = ACTION_BADGE_CLASS[doc.action] || 'bg-cloud text-ink';
                    const canOpen = Boolean(doc.documentId || doc.blob || doc.tool);
                    const canDownload = Boolean(doc.blob || doc.documentId);
                    const relativeTime = doc.timestamp ? formatTimeAgo(doc.timestamp) : doc.timeAgo;
                    const exactTime = doc.timestamp ? formatDateTime(doc.timestamp) : '';

                    return (
                      <tr
                        key={doc.id}
                        className="group hover:bg-linen transition-colors"
                      >
                        <td className="py-3.5 pr-4 pl-2">
                          <div className="flex items-center gap-3 min-w-[180px]">
                            <div className="w-10 h-10 rounded-xl bg-cloud text-ink flex items-center justify-center shrink-0">
                              <FileText className="w-4 h-4" />
                            </div>
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-body-sm font-semibold text-ink truncate max-w-[260px]" title={doc.name}>
                                  {doc.name}
                                </span>
                                <span className="font-mono text-[10px] font-semibold uppercase bg-cloud text-graphite px-1.5 py-0.5 rounded-md shrink-0">
                                  {fmt}
                                </span>
                                {isActive && (
                                  <span className="chip bg-mint text-[10px] font-semibold px-2 py-0.5 shrink-0">
                                    Active
                                  </span>
                                )}
                              </div>
                              {doc.pageCount != null && doc.pageCount > 0 && (
                                <div className="text-caption text-graphite">
                                  {doc.pageCount} {doc.pageCount === 1 ? 'page' : 'pages'}
                                </div>
                              )}
                            </div>
                          </div>
                        </td>

                        <td className="py-3.5 px-4">
                          <div className="flex flex-col items-start gap-1 min-w-[140px]">
                            <span className={`chip text-[11px] font-semibold px-2.5 py-0.5 ${badgeClass}`}>
                              {doc.action}
                            </span>
                            {doc.details && (
                              <span className="text-caption text-graphite">
                                {doc.details}
                              </span>
                            )}
                          </div>
                        </td>

                        <td className="py-3.5 px-4 whitespace-nowrap">
                          <div className="text-body-sm font-medium text-ink tabular-nums">
                            {doc.size || '—'}
                          </div>
                          {doc.originalSize && doc.originalSize !== doc.size && (
                            <div className="text-caption text-graphite tabular-nums">
                              from {doc.originalSize}
                            </div>
                          )}
                        </td>

                        <td className="py-3.5 px-4 whitespace-nowrap">
                          {doc.documentId ? (
                            <span
                              title={doc.documentId}
                              className="font-mono text-[11px] bg-cloud text-ink px-2 py-1 rounded-md"
                            >
                              {doc.documentId.slice(0, 8)}...
                            </span>
                          ) : (
                            <span className="text-caption text-graphite">Local</span>
                          )}
                        </td>

                        <td className="py-3.5 px-4 whitespace-nowrap">
                          <div className="text-body-sm text-ink">{relativeTime}</div>
                          {exactTime && (
                            <div className="text-caption text-graphite tabular-nums">{exactTime}</div>
                          )}
                        </td>

                        <td className="py-3.5 pl-4 pr-2 whitespace-nowrap text-right">
                          <div className="inline-flex items-center justify-end gap-1.5">
                            {canOpen && (
                              <button
                                onClick={() =>
                                  onOpenRecentDoc
                                    ? onOpenRecentDoc(doc)
                                    : doc.documentId && onJoinRoomId(doc.documentId, doc.tool)
                                }
                                className="btn btn-soft h-8 px-3.5 text-caption"
                                title="Open document in editor"
                              >
                                Open
                              </button>
                            )}
                            {canDownload && (
                              <button
                                onClick={() => onSelectRecentDoc(doc)}
                                className="btn btn-ghost h-8 w-8 px-0"
                                title="Download copy"
                                aria-label={`Download ${doc.name}`}
                              >
                                <Download className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
