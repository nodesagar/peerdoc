import React, { useEffect, useRef, useState } from 'react';
import { Check, MessageSquare, RotateCcw, Trash2, X } from 'lucide-react';
import { Annotation, ThreadComment } from '../types';
import { initials, timeAgo, attributionTitle } from '../lib/presence';

export const ANNOTATION_COLORS = ['#f9ab00', '#188038', '#1a73e8', '#d93025', '#9334e6'];
export const ANNOTATION_COLOR_NAMES: Record<string, string> = {
  '#f9ab00': 'Yellow',
  '#188038': 'Green',
  '#1a73e8': 'Blue',
  '#d93025': 'Red',
  '#9334e6': 'Purple',
};
const TYPE_LABEL: Record<Annotation['type'], string> = { highlight: 'Highlight', box: 'Box', ink: 'Drawing', note: 'Note' };

type PeerMark = { name: string; color: string };
type Rect = { x: number; y: number; width: number; height: number };

/** Resize grips: corners and edge midpoints, named by compass side. */
export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const HANDLE_CURSOR: Record<Handle, string> = {
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize',
};

/**
 * `r` with its `handle` dragged to `p` (page percent). Always computed from the rect as
 * grabbed, so dragging past the opposite edge flips the rect instead of going negative.
 */
export function resizeRect(r: Rect, handle: Handle, p: { x: number; y: number }, min = 0.5): Rect {
  let [left, top, right, bottom] = [r.x, r.y, r.x + r.width, r.y + r.height];
  if (handle.includes('w')) left = p.x;
  if (handle.includes('e')) right = p.x;
  if (handle.includes('n')) top = p.y;
  if (handle.includes('s')) bottom = p.y;
  return {
    x: Math.min(left, right),
    y: Math.min(top, bottom),
    width: Math.max(min, Math.abs(right - left)),
    height: Math.max(min, Math.abs(bottom - top)),
  };
}

/** Flat [x0,y0,x1,y1,...] -> SVG points attribute. */
const toPolyline = (pts: number[]) => pts.reduce((s, v, i) => s + (i % 2 ? `,${v} ` : `${v}`), '');

interface AnnotationLayerProps {
  annotations: Annotation[];
  commentCounts: Record<string, number>;
  selectedId: string | null;
  peerSelections: Record<string, PeerMark>;
  draftInk?: number[] | null;
  draftColor: string;
  draftWidth: number;
  /** Show resize grips on the selected highlight or box. */
  resizable: boolean;
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
  draftWidth,
  resizable,
}) => (
  <>
    <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
      {annotations.map((a) => {
        const selected = a.id === selectedId || !!peerSelections[a.id];
        const ring = peerSelections[a.id]?.color ?? '#0087ff'; // Azure: selection
        const line = a.strokeWidth ?? (a.type === 'ink' ? 2.5 : 2);
        const width = selected ? line + 1.5 : line;
        const hit = Math.max(14, line + 10); // invisible grab area around thin lines
        const common = {
          'data-id': a.id,
          className: 'annotation-node cursor-move',
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
            <g key={a.id}>
              {/* wide invisible stroke: a 2px outline alone is near impossible to click */}
              <rect {...common} x={a.x} y={a.y} width={a.width} height={a.height} fill="none" stroke="transparent"
                strokeWidth={hit} vectorEffect="non-scaling-stroke" style={{ pointerEvents: 'stroke' }}>
                <title>{attributionTitle(a)}</title>
              </rect>
              <rect x={a.x} y={a.y} width={a.width} height={a.height} fill="none"
                stroke={a.color} strokeWidth={width} vectorEffect="non-scaling-stroke" />
            </g>
          );
        if (a.type === 'ink' && a.points)
          return (
            <g key={a.id}>
              {/* wide invisible stroke makes thin lines easy to click */}
              <polyline {...common} points={toPolyline(a.points)} fill="none" stroke="transparent" strokeWidth={hit}
                vectorEffect="non-scaling-stroke" style={{ pointerEvents: 'stroke' }}>
                <title>{attributionTitle(a)}</title>
              </polyline>
              <polyline points={toPolyline(a.points)} fill="none" stroke={a.color} strokeWidth={width}
                strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            </g>
          );
        return null;
      })}
      {draftInk && draftInk.length >= 4 && (
        <polyline points={toPolyline(draftInk)} fill="none" stroke={draftColor} strokeWidth={draftWidth}
          strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      )}
    </svg>

    {/* Resize grips on the selected highlight / box (class + data-* read by the editor) */}
    {resizable &&
      annotations
        .filter((a) => a.id === selectedId && (a.type === 'highlight' || a.type === 'box'))
        .flatMap((a) =>
          HANDLES.map((h) => (
            <div
              key={`${a.id}-${h}`}
              data-id={a.id}
              data-handle={h}
              aria-hidden
              className="resize-handle absolute z-[7] w-3 h-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white border-2 border-azure shadow-md-3 touch-none"
              style={{
                left: `${a.x + (h.includes('w') ? 0 : h.includes('e') ? a.width : a.width / 2)}%`,
                top: `${a.y + (h.includes('n') ? 0 : h.includes('s') ? a.height : a.height / 2)}%`,
                cursor: HANDLE_CURSOR[h],
              }}
            />
          ))
        )}

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
            className={`annotation-node annotation-pin absolute z-[6] -translate-y-full flex items-center gap-0.5 px-1.5 py-0.5 rounded-lg rounded-bl-none text-white text-[10px] font-bold shadow-md-3 cursor-move touch-none ${
              a.resolved ? 'opacity-50' : ''
            }`}
            style={{
              left: `${a.x}%`,
              top: `${a.y}%`,
              backgroundColor: a.color,
              outline: a.id === selectedId ? '2px solid var(--color-azure)' : peer ? `2px solid ${peer.color}` : undefined,
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
    // Beside the canvas on wide screens; over it on narrow ones, where a fixed 20rem column
    // would squeeze the page to nothing.
    <aside
      className="w-80 shrink-0 ml-3 mr-4 md:mr-6 my-4 bg-white rounded-3xl shadow-xl flex flex-col min-h-0 overflow-hidden max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:z-40 max-md:w-[min(20rem,calc(100%-2rem))]"
      aria-label="Comments"
    >
      <div className="flex items-center justify-between pl-5 pr-3 py-3 border-b border-ash">
        <h2 className="text-body font-semibold text-ink">Comments</h2>
        <div className="flex items-center gap-2">
          {resolvedCount > 0 && (
            <label className="flex items-center gap-1.5 text-caption text-graphite cursor-pointer">
              <input type="checkbox" className="accent-ink" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
              Show resolved ({resolvedCount})
            </label>
          )}
          <button onClick={onClose} aria-label="Close comments" className="btn btn-ghost h-8 w-8 px-0">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {ordered.length === 0 && (
          <p className="text-body-sm text-graphite text-center py-10 px-4">
            No comments yet. Add a Highlight, Box, Drawing or Note from the toolbar; each one gets a thread here.
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
      className={`rounded-2xl border p-3.5 space-y-2.5 text-body-sm cursor-pointer transition-colors ${
        selected ? 'border-azure bg-azure/[0.04]' : 'border-ash hover:border-stone'
      } ${a.resolved ? 'opacity-70' : ''}`}
      style={peer && !selected ? { borderColor: peer.color } : undefined}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: a.color }} />
          <span className="font-semibold">{TYPE_LABEL[a.type]}</span>
          <span className="text-graphite">· Page {a.pageIndex + 1}</span>
          {peer && (
            <span className="truncate text-caption font-semibold" style={{ color: peer.color }}>
              · {peer.name} is here
            </span>
          )}
        </div>
        <div className="flex items-center shrink-0">
          <button
            onClick={(e) => { e.stopPropagation(); onResolve(); }}
            className="btn btn-ghost h-7 w-7 px-0"
            title={a.resolved ? 'Reopen' : 'Resolve'}
            aria-label={a.resolved ? 'Reopen thread' : 'Resolve thread'}
          >
            {a.resolved ? <RotateCcw className="w-3.5 h-3.5" /> : <Check className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="btn btn-ghost h-7 w-7 px-0 hover:text-papaya"
            title="Delete markup and its comments"
            aria-label="Delete markup"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {comments.map((c) => (
        <div key={c.id} className="group flex gap-2">
          <span
            className="w-6 h-6 rounded-full text-[10px] font-semibold text-white flex items-center justify-center shrink-0"
            style={{ backgroundColor: c.createdByColor ?? 'var(--color-graphite)' }}
            aria-hidden
          >
            {initials(c.createdBy ?? '?')}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-1.5">
              <span className="font-semibold text-ink truncate">{c.createdBy ?? 'Someone'}</span>
              {c.createdAt && <span className="text-caption text-graphite shrink-0">{timeAgo(c.createdAt)}</span>}
              <button
                onClick={(e) => { e.stopPropagation(); onDeleteComment(c.id); }}
                className="ml-auto opacity-0 group-hover:opacity-100 focus:opacity-100 text-graphite hover:text-papaya"
                aria-label="Delete comment"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
            <p className="whitespace-pre-wrap break-words text-ink">{c.text}</p>
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
          className="w-full resize-none rounded-xl border border-transparent bg-linen px-3 py-2 text-body-sm outline-none transition-colors focus:border-azure focus:bg-white"
        />
      )}
    </div>
  );
};
