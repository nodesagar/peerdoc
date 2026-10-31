import React, { useEffect, useRef, useState } from 'react';
import { Check, MessageSquare, RotateCcw, Trash2, X } from 'lucide-react';
import { Annotation, ThreadComment } from '../types';
import { initials, timeAgo, attributionTitle } from '../lib/presence';

export const ANNOTATION_COLORS = ['#f9ab00', '#188038', '#1a73e8', '#d93025', '#9334e6'];
const TYPE_LABEL: Record<Annotation['type'], string> = { highlight: 'Highlight', box: 'Box', ink: 'Drawing', note: 'Note' };

type PeerMark = { name: string; color: string };

/** Flat [x0,y0,x1,y1,...] -> SVG points attribute. */
const toPolyline = (pts: number[]) => pts.reduce((s, v, i) => s + (i % 2 ? `,${v} ` : `${v}`), '');

interface AnnotationLayerProps {
  annotations: Annotation[];
  commentCounts: Record<string, number>;
  selectedId: string | null;
  peerSelections: Record<string, PeerMark>;
  draftInk?: number[] | null;
  draftColor: string;
}

/**
 * Markup for one page. Shapes live in a 0-100 SVG viewBox stretched over the
 * page, so percent coordinates map directly. Elements carry `annotation-node`
 * + data-id so the editor's pointer handler can select them.
 */
export const AnnotationLayer: React.FC<AnnotationLayerProps> = ({
  annotations,
  commentCounts,
  selectedId,
  peerSelections,
  draftInk,
  draftColor,
}) => (
  <>
    <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
      {annotations.map((a) => {
        const selected = a.id === selectedId || !!peerSelections[a.id];
        const ring = peerSelections[a.id]?.color ?? '#005db2';
        const common = {
          'data-id': a.id,
          className: 'annotation-node cursor-pointer',
          style: { pointerEvents: 'visiblePainted' as const },
        };
        if (a.type === 'highlight')
          return (
            <rect key={a.id} {...common} x={a.x} y={a.y} width={a.width} height={a.height} fill={a.color} fillOpacity={0.35}
              stroke={selected ? ring : 'none'} strokeWidth={2} vectorEffect="non-scaling-stroke" style={{ ...common.style, mixBlendMode: 'multiply' }}>
              <title>{attributionTitle(a)}</title>
            </rect>
          );
        if (a.type === 'box')
          return (
            <rect key={a.id} {...common} x={a.x} y={a.y} width={a.width} height={a.height} fill="none"
              stroke={a.color} strokeWidth={selected ? 3.5 : 2} vectorEffect="non-scaling-stroke" style={{ pointerEvents: 'stroke' }}>
              <title>{attributionTitle(a)}</title>
            </rect>
          );
        if (a.type === 'ink' && a.points)
          return (
            <g key={a.id}>
              {/* wide invisible stroke makes thin lines easy to click */}
              <polyline {...common} points={toPolyline(a.points)} fill="none" stroke="transparent" strokeWidth={14}
                vectorEffect="non-scaling-stroke" style={{ pointerEvents: 'stroke' }} />
              <polyline points={toPolyline(a.points)} fill="none" stroke={a.color} strokeWidth={selected ? 3.5 : 2.5}
                strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            </g>
          );
        return null;
      })}
      {draftInk && draftInk.length >= 4 && (
        <polyline points={toPolyline(draftInk)} fill="none" stroke={draftColor} strokeWidth={2.5}
          strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      )}
    </svg>

    {/* Pins: notes, and a comment badge on any markup that has a thread */}
    {annotations
      .filter((a) => a.type === 'note' || commentCounts[a.id])
      .map((a) => {
        const peer = peerSelections[a.id];
        return (
          <div
            key={a.id}
            data-id={a.id}
            title={attributionTitle(a)}
            className={`annotation-node absolute z-[6] -translate-y-full flex items-center gap-0.5 px-1 py-0.5 rounded-md rounded-bl-none text-white text-[10px] font-bold shadow cursor-pointer ${
              a.resolved ? 'opacity-50' : ''
            }`}
            style={{
              left: `${a.x}%`,
              top: `${a.y}%`,
              backgroundColor: a.color,
              outline: a.id === selectedId ? '2px solid #005db2' : peer ? `2px solid ${peer.color}` : undefined,
              outlineOffset: 1,
            }}
          >
            <MessageSquare className="w-3 h-3" />
            {commentCounts[a.id] ? <span>{commentCounts[a.id]}</span> : null}
          </div>
        );
      })}
  </>
);

interface CommentsPanelProps {
  annotations: Annotation[];
  comments: ThreadComment[];
  selectedId: string | null;
  focusReplyFor: string | null;
  peerSelections: Record<string, PeerMark>;
  onSelect: (id: string) => void;
  onReply: (annotationId: string, text: string) => void;
  onResolve: (id: string, resolved: boolean) => void;
  onDelete: (id: string) => void;
  onDeleteComment: (id: string) => void;
  onClose: () => void;
}

/** Review sidebar: every annotation as a thread, in page order. */
export const CommentsPanel: React.FC<CommentsPanelProps> = ({
  annotations,
  comments,
  selectedId,
  focusReplyFor,
  peerSelections,
  onSelect,
  onReply,
  onResolve,
  onDelete,
  onDeleteComment,
  onClose,
}) => {
  const [showResolved, setShowResolved] = useState(false);
  const ordered = [...annotations]
    .filter((a) => showResolved || !a.resolved || a.id === selectedId)
    .sort((a, b) => a.pageIndex - b.pageIndex || a.y - b.y || a.x - b.x);
  const resolvedCount = annotations.filter((a) => a.resolved).length;

  return (
    <aside className="w-80 shrink-0 bg-white border-l border-black/10 flex flex-col min-h-0" aria-label="Comments">
      <div className="flex items-center justify-between px-4 py-3 border-b border-black/10">
        <h2 className="text-sm font-semibold">Comments</h2>
        <div className="flex items-center gap-2">
          {resolvedCount > 0 && (
            <label className="flex items-center gap-1 text-[11px] text-[#5f6368] cursor-pointer">
              <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
              Resolved ({resolvedCount})
            </label>
          )}
          <button onClick={onClose} aria-label="Close comments" className="p-1 rounded hover:bg-black/5">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {ordered.length === 0 && (
          <p className="text-xs text-[#5f6368] text-center py-8 px-4">
            No comments yet. Use Highlight, Box, Draw or Note in the toolbar, then click it to start a thread.
          </p>
        )}
        {ordered.map((a) => (
          <Thread
            key={a.id}
            annotation={a}
            comments={comments.filter((c) => c.annotationId === a.id)}
            selected={a.id === selectedId}
            autoFocus={a.id === focusReplyFor}
            peer={peerSelections[a.id]}
            onSelect={() => onSelect(a.id)}
            onReply={(text) => onReply(a.id, text)}
            onResolve={() => onResolve(a.id, !a.resolved)}
            onDelete={() => onDelete(a.id)}
            onDeleteComment={onDeleteComment}
          />
        ))}
      </div>
    </aside>
  );
};

const Thread: React.FC<{
  annotation: Annotation;
  comments: ThreadComment[];
  selected: boolean;
  autoFocus: boolean;
  peer?: PeerMark;
  onSelect: () => void;
  onReply: (text: string) => void;
  onResolve: () => void;
  onDelete: () => void;
  onDeleteComment: (id: string) => void;
}> = ({ annotation: a, comments, selected, autoFocus, peer, onSelect, onReply, onResolve, onDelete, onDeleteComment }) => {
  const [draft, setDraft] = useState('');
  const cardRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (selected) cardRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selected]);
  useEffect(() => {
    if (!autoFocus) return;
    // After the creating click's default action, which would move focus back to the page
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [autoFocus]);

  const send = () => {
    if (!draft.trim()) return;
    onReply(draft);
    setDraft('');
  };

  return (
    <div
      ref={cardRef}
      onClick={onSelect}
      className={`rounded-xl border p-3 space-y-2 text-xs cursor-pointer transition-colors ${
        selected ? 'border-[#005db2] bg-blue-50/40' : 'border-black/10 hover:border-black/20'
      } ${a.resolved ? 'opacity-70' : ''}`}
      style={peer && !selected ? { borderColor: peer.color } : undefined}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: a.color }} />
          <span className="font-semibold">{TYPE_LABEL[a.type]}</span>
          <span className="text-[#5f6368]">· Page {a.pageIndex + 1}</span>
          {peer && (
            <span className="truncate text-[10px] font-semibold" style={{ color: peer.color }}>
              · {peer.name} is here
            </span>
          )}
        </div>
        <div className="flex items-center shrink-0">
          <button
            onClick={(e) => { e.stopPropagation(); onResolve(); }}
            className="p-1 rounded hover:bg-black/5 text-[#5f6368] hover:text-emerald-700"
            title={a.resolved ? 'Reopen' : 'Resolve'}
            aria-label={a.resolved ? 'Reopen thread' : 'Resolve thread'}
          >
            {a.resolved ? <RotateCcw className="w-3.5 h-3.5" /> : <Check className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="p-1 rounded hover:bg-black/5 text-[#5f6368] hover:text-red-600"
            title="Delete markup and its comments"
            aria-label="Delete annotation"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {comments.map((c) => (
        <div key={c.id} className="group flex gap-2">
          <span
            className="w-5 h-5 rounded-full text-[9px] font-bold text-white flex items-center justify-center shrink-0"
            style={{ backgroundColor: c.createdByColor ?? '#5f6368' }}
            aria-hidden
          >
            {initials(c.createdBy ?? '?')}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-1.5">
              <span className="font-semibold truncate">{c.createdBy ?? 'Someone'}</span>
              {c.createdAt && <span className="text-[10px] text-[#5f6368] shrink-0">{timeAgo(c.createdAt)}</span>}
              <button
                onClick={(e) => { e.stopPropagation(); onDeleteComment(c.id); }}
                className="ml-auto opacity-0 group-hover:opacity-100 focus:opacity-100 text-[#5f6368] hover:text-red-600"
                aria-label="Delete comment"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
            <p className="whitespace-pre-wrap break-words text-[#1a1c1c]">{c.text}</p>
          </div>
        </div>
      ))}

      {!a.resolved && (
        <textarea
          ref={inputRef}
          value={draft}
          rows={1}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={comments.length ? 'Reply…' : 'Add a comment…'}
          aria-label={comments.length ? 'Reply' : 'Add a comment'}
          className="w-full resize-none rounded-lg border border-black/10 bg-[#f4f3f2] px-2 py-1.5 outline-none focus:border-[#005db2] focus:bg-white"
        />
      )}
    </div>
  );
};
