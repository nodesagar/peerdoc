import React, { useState } from 'react';
import { ActiveTool, ProcessedDoc } from '../types';
import {
  PenTool,
  Layers,
  EyeOff,
  Edit3,
  Minimize2,
  ArrowRight,
  ShieldCheck,
  FileText,
  Clock,
  Trash2,
  Download,
  Stamp,
  SplitSquareHorizontal as Scissors,
  Lock,
  Sparkles,
  Share2,
  WifiOff,
  FileCheck2,
  Upload,
} from 'lucide-react';
import { pressable } from '../lib/pressable';
import { Highlighter } from './ui/highlighter';

interface DashboardProps {
  setActiveTool: (tool: ActiveTool) => void;
  recentDocs: ProcessedDoc[];
  onClearHistory: () => void;
  onSelectRecentDoc: (doc: ProcessedDoc) => void;
  onLoadSample: () => void;
  onUploadNewDoc: (file: File) => void;
  onJoinRoomId: (roomId: string) => void;
  activeDocId: string | null;
}

export const Dashboard: React.FC<DashboardProps> = ({
  setActiveTool,
  recentDocs,
  onClearHistory,
  onSelectRecentDoc,
  onLoadSample,
  onUploadNewDoc,
  onJoinRoomId,
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
    <div className="max-w-[1280px] mx-auto px-4 md:px-8 pt-8 pb-16 space-y-12 animate-in fade-in duration-200">
      {/* Hero Section */}
      <div className="text-center space-y-6 max-w-3xl mx-auto">
        <div className="inline-flex items-center space-x-2 bg-emerald-50/90 text-emerald-800 text-xs md:text-sm font-medium tracking-wide px-3 md:px-4 py-1.5 rounded-full border border-emerald-200 shadow-2xs backdrop-blur-sm">
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
          </span>
          <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0" />
          <span className="font-semibold tracking-wider text-[11px] md:text-xs">
            100% P2P &bull; OFFLINE-FIRST &bull; ZERO CENTRAL SERVER
          </span>
        </div>

        <h1 className="text-4xl md:text-6xl font-serif-heading font-bold text-[#1a1c1c] leading-[1.15] tracking-tight">
          <span>Edit & Sync PDFs,</span>{' '}
          <span className="badge-float bg-[#f64932] text-white px-3.5 py-1 rounded-2xl inline-block font-sans text-3xl md:text-5xl font-semibold shadow-sm mt-1">
            Strictly P2P.
          </span>
        </h1>

        <p className="text-base md:text-lg text-[#414753] max-w-2xl mx-auto font-sans leading-relaxed">
          <Highlighter action="underline" color="#FF9800">
            Work offline for weeks.
          </Highlighter>{' '}
          Sync in any order, direct peer-to-peer via WebRTC and CRDTs. Always converges to the exact same document.
        </p>

        {/* Action bar: Upload, Load Demo, or Join Room */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="w-full sm:w-auto flex items-center justify-center space-x-2 bg-[#005db2] hover:bg-[#004a8f] text-white font-medium px-5 py-2.5 rounded-xl shadow-sm transition-all hover:scale-[1.02] cursor-pointer"
          >
            <Upload className="w-4 h-4" />
            <span>Open Local PDF</span>
          </button>
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFilePicked}
            accept="application/pdf"
            className="hidden"
          />

          <button
            onClick={onLoadSample}
            className="w-full sm:w-auto flex items-center justify-center space-x-2 bg-white hover:bg-black/5 text-[#1a1c1c] border border-black/15 font-medium px-5 py-2.5 rounded-xl shadow-2xs transition-colors cursor-pointer"
          >
            <Sparkles className="w-4 h-4 text-amber-500" />
            <span>Load Demo Agreement</span>
          </button>

          {/* Join room input */}
          <form onSubmit={handleJoinSubmit} className="w-full sm:w-auto flex items-center">
            <div className="relative flex items-center w-full">
              <input
                type="text"
                placeholder="Paste share link..."
                value={joinInput}
                onChange={(e) => setJoinInput(e.target.value)}
                className="w-full sm:w-64 bg-white border border-black/15 text-xs rounded-xl px-3 py-2.5 pr-14 focus:outline-none focus:border-[#005db2]"
              />
              <button
                type="submit"
                disabled={!joinInput.trim()}
                className="absolute right-1 text-xs bg-black/5 hover:bg-[#005db2] hover:text-white disabled:opacity-30 px-2.5 py-1.5 rounded-lg transition-colors font-medium cursor-pointer"
              >
                Join
              </button>
            </div>
          </form>
        </div>

        {activeDocId && (
          <div className="text-xs text-black/60 pt-1">
            Active Document Room:{' '}
            <span className="font-mono bg-black/5 px-2 py-0.5 rounded text-[#005db2] font-semibold">
              {activeDocId.slice(0, 12)}...
            </span>
          </div>
        )}
      </div>

      {/* Primary Tools Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {/* 1. Edit PDF */}
        <div
          {...pressable(() => setActiveTool('edit'))}
          className="group relative bg-white rounded-2xl p-5 border border-black/[0.08] shadow-2xs hover:shadow-xl hover:border-emerald-500/40 hover:-translate-y-1.5 transition-all duration-300 cursor-pointer flex flex-col justify-between overflow-hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#005db2]"
        >
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-emerald-400 to-teal-500 opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center">
                <Edit3 className="w-5 h-5" />
              </div>
              <span className="text-[11px] font-mono text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                CRDT-Synced
              </span>
            </div>
            <h3 className="text-lg font-bold text-[#1a1c1c]">Edit Text & Erase</h3>
            <p className="text-xs text-[#5f6368] leading-relaxed">
              Add custom text overlays, modify font styling, and whiteout sections with nested CRDT field merges.
            </p>
          </div>
          <div className="pt-4 flex items-center text-xs font-semibold text-emerald-600 group-hover:translate-x-1 transition-transform">
            <span>Open Editor</span>
            <ArrowRight className="w-3.5 h-3.5 ml-1" />
          </div>
        </div>

        {/* 2. Organize Pages */}
        <div
          {...pressable(() => setActiveTool('organize'))}
          className="group relative bg-white rounded-2xl p-5 border border-black/[0.08] shadow-2xs hover:shadow-xl hover:border-blue-500/40 hover:-translate-y-1.5 transition-all duration-300 cursor-pointer flex flex-col justify-between overflow-hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#005db2]"
        >
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-blue-400 to-indigo-500 opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="w-10 h-10 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center">
                <Layers className="w-5 h-5" />
              </div>
              <span className="text-[11px] font-mono text-blue-700 bg-blue-50 px-2 py-0.5 rounded border border-blue-200">
                Fractional Index
              </span>
            </div>
            <h3 className="text-lg font-bold text-[#1a1c1c]">Organize & Reorder</h3>
            <p className="text-xs text-[#5f6368] leading-relaxed">
              Drag-and-drop page reordering, non-destructive rotation, and page deletions that merge deterministically.
            </p>
          </div>
          <div className="pt-4 flex items-center text-xs font-semibold text-blue-600 group-hover:translate-x-1 transition-transform">
            <span>Organize Pages</span>
            <ArrowRight className="w-3.5 h-3.5 ml-1" />
          </div>
        </div>

        {/* 3. True Redact */}
        <div
          {...pressable(() => setActiveTool('redact'))}
          className="group relative bg-white rounded-2xl p-5 border border-black/[0.08] shadow-2xs hover:shadow-xl hover:border-rose-500/40 hover:-translate-y-1.5 transition-all duration-300 cursor-pointer flex flex-col justify-between overflow-hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#005db2]"
        >
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-rose-400 to-red-500 opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="w-10 h-10 rounded-xl bg-rose-50 text-rose-600 flex items-center justify-center">
                <EyeOff className="w-5 h-5" />
              </div>
              <span className="text-[11px] font-mono text-rose-700 bg-rose-50 px-2 py-0.5 rounded border border-rose-200">
                True Scrubbing
              </span>
            </div>
            <h3 className="text-lg font-bold text-[#1a1c1c]">Redact & Sanitize</h3>
            <p className="text-xs text-[#5f6368] leading-relaxed">
              Truly burns sensitive regions into rasterized pixels to prevent text recovery. Strips document metadata.
            </p>
          </div>
          <div className="pt-4 flex items-center text-xs font-semibold text-rose-600 group-hover:translate-x-1 transition-transform">
            <span>Redact Content</span>
            <ArrowRight className="w-3.5 h-3.5 ml-1" />
          </div>
        </div>

        {/* 4. Digital Signature */}
        <div
          {...pressable(() => setActiveTool('sign'))}
          className="group relative bg-white rounded-2xl p-5 border border-black/[0.08] shadow-2xs hover:shadow-xl hover:border-purple-500/40 hover:-translate-y-1.5 transition-all duration-300 cursor-pointer flex flex-col justify-between overflow-hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#005db2]"
        >
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-purple-400 to-pink-500 opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="w-10 h-10 rounded-xl bg-purple-50 text-purple-600 flex items-center justify-center">
                <PenTool className="w-5 h-5" />
              </div>
              <span className="text-[11px] font-mono text-purple-700 bg-purple-50 px-2 py-0.5 rounded border border-purple-200">
                P2P Stamp
              </span>
            </div>
            <h3 className="text-lg font-bold text-[#1a1c1c]">Sign Document</h3>
            <p className="text-xs text-[#5f6368] leading-relaxed">
              Draw, type, or upload digital signatures and stamp them collaboratively onto pages.
            </p>
          </div>
          <div className="pt-4 flex items-center text-xs font-semibold text-purple-600 group-hover:translate-x-1 transition-transform">
            <span>Sign PDF</span>
            <ArrowRight className="w-3.5 h-3.5 ml-1" />
          </div>
        </div>

        {/* 5. Compress PDF */}
        <div
          {...pressable(() => setActiveTool('compress'))}
          className="group relative bg-white rounded-2xl p-5 border border-black/[0.08] shadow-2xs hover:shadow-xl hover:border-amber-500/40 hover:-translate-y-1.5 transition-all duration-300 cursor-pointer flex flex-col justify-between overflow-hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#005db2]"
        >
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-amber-400 to-orange-500 opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="w-10 h-10 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center">
                <Minimize2 className="w-5 h-5" />
              </div>
              <span className="text-[11px] font-mono text-amber-700 bg-amber-50 px-2 py-0.5 rounded border border-amber-200">
                Optimizer
              </span>
            </div>
            <h3 className="text-lg font-bold text-[#1a1c1c]">Compress</h3>
            <p className="text-xs text-[#5f6368] leading-relaxed">
              Shrink file sizes locally with stream optimization without compromising document clarity.
            </p>
          </div>
          <div className="pt-4 flex items-center text-xs font-semibold text-amber-600 group-hover:translate-x-1 transition-transform">
            <span>Compress PDF</span>
            <ArrowRight className="w-3.5 h-3.5 ml-1" />
          </div>
        </div>

        {/* 6. Merge PDFs */}
        <div
          {...pressable(() => setActiveTool('merge'))}
          className="group relative bg-white rounded-2xl p-5 border border-black/[0.08] shadow-2xs hover:shadow-xl hover:border-teal-500/40 hover:-translate-y-1.5 transition-all duration-300 cursor-pointer flex flex-col justify-between overflow-hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#005db2]"
        >
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-teal-400 to-cyan-500 opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="w-10 h-10 rounded-xl bg-teal-50 text-teal-600 flex items-center justify-center">
                <Scissors className="w-5 h-5 rotate-90" />
              </div>
              <span className="text-[11px] font-mono text-teal-700 bg-teal-50 px-2 py-0.5 rounded border border-teal-200">
                Multi-Doc
              </span>
            </div>
            <h3 className="text-lg font-bold text-[#1a1c1c]">Merge Documents</h3>
            <p className="text-xs text-[#5f6368] leading-relaxed">
              Combine multiple files into a single master PDF with seamless client-side page copying.
            </p>
          </div>
          <div className="pt-4 flex items-center text-xs font-semibold text-teal-600 group-hover:translate-x-1 transition-transform">
            <span>Merge Files</span>
            <ArrowRight className="w-3.5 h-3.5 ml-1" />
          </div>
        </div>
      </div>

      {/* Recent Documents History */}
      <div className="bg-white rounded-2xl border border-black/[0.08] p-6 shadow-2xs space-y-4">
        <div className="flex items-center justify-between border-b border-black/5 pb-4">
          <div className="flex items-center space-x-2">
            <Clock className="w-5 h-5 text-[#005db2]" />
            <h2 className="text-lg font-bold text-[#1a1c1c]">Recent Documents</h2>
            <span className="text-xs text-[#5f6368] font-mono">({recentDocs.length})</span>
          </div>
          {recentDocs.length > 0 && (
            <button
              onClick={onClearHistory}
              className="text-xs text-red-600 hover:text-red-700 flex items-center space-x-1 hover:bg-red-50 px-2.5 py-1.5 rounded-lg transition-colors cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Clear History</span>
            </button>
          )}
        </div>

        {recentDocs.length === 0 ? (
          <div className="text-center py-8 text-xs text-[#5f6368]">
            No recent documents yet. Open a PDF or load the demo agreement above!
          </div>
        ) : (
          <div className="divide-y divide-black/5">
            {recentDocs.map((doc) => (
              <div
                key={doc.id}
                className="py-3 flex items-center justify-between hover:bg-black/[0.02] px-2 rounded-lg transition-colors"
              >
                <div className="flex items-center space-x-3">
                  <div className="w-8 h-8 rounded-lg bg-[#005db2]/10 text-[#005db2] flex items-center justify-center">
                    <FileText className="w-4 h-4" />
                  </div>
                  <div>
                    <h4 className="text-sm font-semibold text-[#1a1c1c]">{doc.name}</h4>
                    <div className="flex items-center space-x-2 text-[11px] text-[#5f6368]">
                      <span>{doc.action}</span>
                      <span>&bull;</span>
                      <span>{doc.size}</span>
                      <span>&bull;</span>
                      <span>{doc.timeAgo}</span>
                      {doc.documentId && (
                        <>
                          <span>&bull;</span>
                          <span className="font-mono text-[10px] bg-black/5 px-1 rounded">
                            {doc.documentId.slice(0, 8)}...
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center space-x-2">
                  {doc.documentId && (
                    <button
                      onClick={() => onJoinRoomId(doc.documentId!)}
                      className="text-xs text-[#005db2] hover:bg-[#005db2]/10 px-2.5 py-1.5 rounded-lg font-medium transition-colors"
                      title="Open in Collaborative CRDT Room"
                    >
                      Open
                    </button>
                  )}
                  {doc.blob && (
                    <button
                      onClick={() => onSelectRecentDoc(doc)}
                      className="p-1.5 text-black/60 hover:text-black hover:bg-black/5 rounded-lg transition-colors"
                      title="Download copy"
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
  );
};
