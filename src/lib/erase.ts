import type { Annotation } from '../types';

/**
 * Markup eraser geometry. Everything is in page percent, like the annotations
 * themselves; `aspect` (page height / width) turns y-percent into x-units so the
 * brush is a true circle on a non-square page.
 */
export type Pt = { x: number; y: number };
export interface Brush {
  /** Sweep from `a` to `b` (one pointer move), so fast strokes leave no gaps. */
  a: Pt;
  b: Pt;
  /** Radius in percent of page width. */
  r: number;
  aspect: number;
}
type Rect = { x: number; y: number; width: number; height: number };

const distToSegment = (p: Pt, a: Pt, b: Pt, aspect: number) => {
  const [px, py, ax, ay, bx, by] = [p.x, p.y * aspect, a.x, a.y * aspect, b.x, b.y * aspect];
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

/** Brush sweep sampled every r/2, so rect tests can check points. */
const sweep = ({ a, b, r, aspect }: Brush): Pt[] => {
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, (b.y - a.y) * aspect) / (r / 2)));
  return Array.from({ length: n + 1 }, (_, i) => ({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n }));
};

/** Does the brush touch the rectangle (filled) or only its outline (`outline`)? */
export function brushHitsRect(rect: Rect, brush: Brush, outline = false): boolean {
  const { r, aspect } = brush;
  return sweep(brush).some((p) => {
    const ox = Math.max(rect.x - p.x, 0, p.x - (rect.x + rect.width));
    const oy = Math.max(rect.y - p.y, 0, p.y - (rect.y + rect.height)) * aspect;
    const outside = Math.hypot(ox, oy);
    if (outside > 0 || !outline) return outside <= r;
    // Inside a box: near any edge?
    const edge = Math.min(p.x - rect.x, rect.x + rect.width - p.x, (p.y - rect.y) * aspect, (rect.y + rect.height - p.y) * aspect);
    return edge <= r;
  });
}

/** Bounding box of a flat [x0,y0,x1,y1,...] stroke. */
export function inkBounds(points: number[]): Rect {
  const xs = points.filter((_, i) => i % 2 === 0);
  const ys = points.filter((_, i) => i % 2 === 1);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/**
 * Rubs the brush through a stroke. Returns null if untouched, else the surviving
 * pieces (possibly none). The stroke is densified first so a long segment crossing
 * the brush is cut even when both its ends lie outside it.
 */
export function eraseInk(points: number[], brush: Brush): number[][] | null {
  const { r, aspect } = brush;
  const dense: Pt[] = [];
  for (let i = 0; i + 1 < points.length; i += 2) {
    const p = { x: points[i], y: points[i + 1] };
    const prev = dense[dense.length - 1];
    if (prev) {
      const n = Math.ceil(Math.hypot(p.x - prev.x, (p.y - prev.y) * aspect) / (r / 2));
      for (let k = 1; k < n; k++) dense.push({ x: prev.x + ((p.x - prev.x) * k) / n, y: prev.y + ((p.y - prev.y) * k) / n });
    }
    dense.push(p);
  }

  const pieces: number[][] = [];
  let piece: number[] = [];
  let touched = false;
  for (const p of dense) {
    if (distToSegment(p, brush.a, brush.b, aspect) <= r) {
      touched = true;
      if (piece.length >= 4) pieces.push(piece);
      piece = [];
    } else piece.push(Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100);
  }
  if (piece.length >= 4) pieces.push(piece);
  return touched ? pieces : null;
}

export interface EraseResult {
  remove: string[];
  update: { id: string; patch: Pick<Annotation, 'x' | 'y' | 'width' | 'height' | 'points'> }[];
  add: Omit<Annotation, 'id'>[];
}

/**
 * One brush sweep over a page's markup: drawings are cut where rubbed (the first
 * piece keeps the id and comment thread, the rest become new drawings), highlights
 * and boxes touched are removed whole. Notes are skipped: they carry threads.
 */
export function eraseAnnotations(annotations: Annotation[], brush: Brush): EraseResult {
  const out: EraseResult = { remove: [], update: [], add: [] };
  for (const a of annotations) {
    if (a.type === 'ink' && a.points) {
      const pieces = eraseInk(a.points, brush);
      if (!pieces) continue;
      if (!pieces.length) {
        out.remove.push(a.id);
        continue;
      }
      const [first, ...rest] = pieces;
      out.update.push({ id: a.id, patch: { ...inkBounds(first), points: first } });
      const { id: _id, ...base } = a;
      for (const p of rest) out.add.push({ ...base, ...inkBounds(p), points: p });
    } else if ((a.type === 'highlight' || a.type === 'box') && brushHitsRect(a, brush, a.type === 'box')) {
      out.remove.push(a.id);
    }
  }
  return out;
}
