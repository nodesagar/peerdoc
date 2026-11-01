import { describe, it, expect } from 'vitest';
import { eraseAnnotations, eraseInk } from '../lib/erase';
import type { Annotation } from '../types';

const dot = (x: number, y: number, r = 2) => ({ a: { x, y }, b: { x, y }, r, aspect: 1 });
const base = { pageIndex: 0, color: '#f9ab00', createdBy: 'Ann' };

describe('markup eraser', () => {
  it('cuts a drawing in two where the brush passes, the far piece keeps author and width', () => {
    // Horizontal line 10 -> 90 at y 50, only two points: densifying must still cut the middle
    const ink: Annotation = { ...base, id: 'i', type: 'ink', x: 10, y: 50, width: 80, height: 0, points: [10, 50, 90, 50], strokeWidth: 6 };
    const { remove, update, add } = eraseAnnotations([ink], dot(50, 50));
    expect(remove).toEqual([]);
    expect(update).toHaveLength(1);
    expect(update[0].id).toBe('i');
    expect(Math.max(...update[0].patch.points!.filter((_, i) => i % 2 === 0))).toBeLessThan(48);
    expect(add).toHaveLength(1);
    expect(add[0]).toMatchObject({ type: 'ink', createdBy: 'Ann', strokeWidth: 6 });
    expect(Math.min(...add[0].points!.filter((_, i) => i % 2 === 0))).toBeGreaterThan(52);
  });

  it('removes a drawing rubbed out entirely, leaves an untouched one alone', () => {
    expect(eraseInk([50, 50, 50.5, 50], dot(50, 50))).toEqual([]);
    expect(eraseInk([10, 10, 20, 10], dot(50, 50))).toBeNull();
  });

  it('sweeps the whole move, so a fast stroke leaves no gap', () => {
    const ink: Annotation = { ...base, id: 'v', type: 'ink', x: 50, y: 0, width: 0, height: 100, points: [50, 0, 50, 100] };
    const brush = { a: { x: 0, y: 50 }, b: { x: 100, y: 50 }, r: 1, aspect: 1 };
    expect(eraseAnnotations([ink], brush).add).toHaveLength(1); // split into top and bottom
  });

  it('box goes when its outline is touched, not its empty middle; highlight anywhere', () => {
    const box: Annotation = { ...base, id: 'b', type: 'box', x: 20, y: 20, width: 60, height: 60 };
    const hl: Annotation = { ...base, id: 'h', type: 'highlight', x: 20, y: 20, width: 60, height: 60 };
    expect(eraseAnnotations([box, hl], dot(50, 50)).remove).toEqual(['h']);
    expect(eraseAnnotations([box], dot(21, 50)).remove).toEqual(['b']);
  });

  it('never erases notes (they hold comment threads)', () => {
    const note: Annotation = { ...base, id: 'n', type: 'note', x: 50, y: 50, width: 0, height: 0 };
    expect(eraseAnnotations([note], dot(50, 50)).remove).toEqual([]);
  });
});
