import React, { useState } from 'react';
import { ActiveTool, ProcessedDoc } from '../types';
import {
  PenTool,
  Layers,
  EyeOff,
  Edit3,
  Minimize2,
  ArrowRight,
  FileText,
  Clock,
  Trash2,
  Download,
  SplitSquareHorizontal as Scissors,
  Upload,
} from 'lucide-react';
import { pressable } from '../lib/pressable';
import { OPEN_ACCEPT } from '../lib/formats';

interface DashboardProps {
  setActiveTool: (tool: ActiveTool) => void;
  recentDocs: ProcessedDoc[];
  onClearHistory: () => void;
  onSelectRecentDoc: (doc: ProcessedDoc) => void;
  onLoadSample: () => void;
  onUploadNewDoc: (file: File) => void;
  onJoinRoomId: (roomId: string) => void;
  onNewWordDoc: () => void;
  activeDocId: string | null;
}

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
  onClearHistory,
  onSelectRecentDoc,
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
          <h1 className="text-balance font-serif text-heading-sm font-normal text-ink sm:text-heading md:text-display">
            Edit Word and PDF files without uploading them.
          </h1>

          <p className="mx-auto mt-5 max-w-2xl text-pretty text-body text-graphite md:text-lg">
            Open, sign, reorder, or redact files on your device. Share a room link when you want to edit together.
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
              <span>New Word document</span>
            </button>

            <button
              onClick={onLoadSample}
              className="btn btn-secondary h-12 w-full px-6 text-body sm:w-auto"
            >
              <FileText className="w-4 h-4" />
              <span>Try a sample PDF</span>
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
          <div className="flex items-center justify-between gap-3 border-b border-ash pb-5">
            <div className="flex items-center gap-3">
              <span className="w-10 h-10 rounded-full bg-linen text-ink flex items-center justify-center shrink-0">
                <Clock className="w-[18px] h-[18px]" />
              </span>
              <h2 className="font-serif text-subheading text-ink">Recent Documents</h2>
              <span className="text-caption text-graphite tabular-nums">({recentDocs.length})</span>
            </div>
            {recentDocs.length > 0 && (
              <button onClick={onClearHistory} className="btn btn-ghost h-9 px-3.5 text-caption">
                <Trash2 className="w-3.5 h-3.5 text-papaya" />
                <span>Clear History</span>
              </button>
            )}
          </div>

          {recentDocs.length === 0 ? (
            <div className="text-center py-10 text-body-sm text-graphite">
              No recent documents yet. Open a PDF or load the demo agreement above!
            </div>
          ) : (
            <div className="divide-y divide-ash">
              {recentDocs.map((doc) => (
                <div
                  key={doc.id}
                  className="py-3 px-3 -mx-3 flex items-center justify-between gap-3 rounded-2xl hover:bg-linen transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-10 h-10 rounded-xl bg-cloud text-ink flex items-center justify-center shrink-0">
                      <FileText className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <h4 className="text-body-sm font-semibold text-ink truncate">{doc.name}</h4>
                      <div className="flex flex-wrap items-center gap-x-2 text-caption text-graphite">
                        <span>{doc.action}</span>
                        <span aria-hidden>&bull;</span>
                        <span>{doc.size}</span>
                        <span aria-hidden>&bull;</span>
                        <span>{doc.timeAgo}</span>
                        {doc.documentId && (
                          <>
                            <span aria-hidden>&bull;</span>
                            <span className="font-mono text-[11px] bg-cloud px-1.5 rounded-md">
                              {doc.documentId.slice(0, 8)}...
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    {doc.documentId && (
                      <button
                        onClick={() => onJoinRoomId(doc.documentId!)}
                        className="btn btn-soft h-8 px-3.5 text-caption"
                        title="Open in Collaborative CRDT Room"
                      >
                        Open
                      </button>
                    )}
                    {doc.blob && (
                      <button
                        onClick={() => onSelectRecentDoc(doc)}
                        className="btn btn-ghost h-8 w-8 px-0"
                        title="Download copy"
                        aria-label="Download copy"
                      >
                        <Download className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
