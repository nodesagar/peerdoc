import { describe, it, expect } from 'vitest';
import { generateFractionalIndex, generateInitialIndices } from '../lib/crdt/fractionalIndex';

describe('Fractional Indexing', () => {
  it('generates a default midpoint when both bounds are null', () => {
    const idx = generateFractionalIndex(null, null);
    expect(idx).toBe('m');
  });

  it('generates an index strictly smaller than next when prepending', () => {
    const next = 'm';
    const idx = generateFractionalIndex(null, next);
    expect(idx < next).toBe(true);
  });

  it('generates an index strictly greater than prev when appending', () => {
    const prev = 'm';
    const idx = generateFractionalIndex(prev, null);
    expect(idx > prev).toBe(true);
  });

  it('generates an intermediate index between adjacent characters', () => {
    const prev = 'a';
    const next = 'b';
    const mid = generateFractionalIndex(prev, next);
    expect(mid > prev).toBe(true);
    expect(mid < next).toBe(true);
  });

  it('generates an intermediate index between non-adjacent characters', () => {
    const prev = 'a';
    const next = 'g';
    const mid = generateFractionalIndex(prev, next);
    expect(mid > prev).toBe(true);
    expect(mid < next).toBe(true);
  });

  it('maintains strict monotonic order across 100 sequential insertions at random positions', () => {
    const list: string[] = ['a', 'z'];

    for (let step = 0; step < 100; step++) {
      // Pick random adjacent pair
      const insertIdx = Math.floor(Math.random() * (list.length - 1));
      const prev = list[insertIdx];
      const next = list[insertIdx + 1];

      const newKey = generateFractionalIndex(prev, next);
      expect(newKey > prev).toBe(true);
      expect(newKey < next).toBe(true);

      list.splice(insertIdx + 1, 0, newKey);
    }

    // Verify entire list is strictly sorted
    for (let i = 0; i < list.length - 1; i++) {
      expect(list[i] < list[i + 1]).toBe(true);
    }
  });

  it('generates initial indices for N items in strict ascending order', () => {
    const count = 10;
    const indices = generateInitialIndices(count);
    expect(indices.length).toBe(count);

    for (let i = 0; i < count - 1; i++) {
      expect(indices[i] < indices[i + 1]).toBe(true);
    }
  });

  it('keeps order under repeated prepends (no keys ending in "0")', () => {
    let key = '1m';
    for (let i = 0; i < 30; i++) {
      const next = generateFractionalIndex(null, key);
      expect(next < key).toBe(true);
      key = next;
    }
  });
});
