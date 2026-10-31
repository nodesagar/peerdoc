/**
 * Fractional Indexing module for deterministic, conflict-free sequence ordering.
 * Used for page ordering in Yjs without deleting/reinserting on arrays.
 * 
 * Invariants:
 *  - prev < next in lexicographical sort
 *  - generateFractionalIndex(prev, next) returns s such that prev < s < next
 *  - generateFractionalIndex(prev, null) returns s such that prev < s
 *  - generateFractionalIndex(null, next) returns s such that s < next
 *  - generateFractionalIndex(null, null) returns a default midpoint "m"
 */

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';

function getCharVal(c: string): number {
  return DIGITS.indexOf(c);
}

function getValChar(val: number): string {
  return DIGITS[val];
}

/**
 * Computes a midpoint string between two strings `prev` and `next`.
 */
export function generateFractionalIndex(
  prev?: string | null,
  next?: string | null
): string {
  // If both empty, return default midpoint
  if (!prev && !next) {
    return 'm';
  }

  // Prepend before next
  if (!prev && next) {
    let result = '';
    for (let i = 0; i < next.length; i++) {
      const nextVal = getCharVal(next[i]);
      if (nextVal > 0) {
        const midVal = Math.floor(nextVal / 2);
        // Never emit a key ending in '0': nothing can be prepended before it.
        return result + (midVal === 0 ? '0m' : getValChar(midVal));
      }
      result += '0';
    }
    return result + 'm';
  }

  // Append after prev
  if (prev && !next) {
    // Increment the last character if possible, or append 'm'
    const lastChar = prev[prev.length - 1];
    const lastVal = getCharVal(lastChar);
    if (lastVal < DIGITS.length - 2) {
      return prev.slice(0, -1) + getValChar(lastVal + 1);
    }
    return prev + 'm';
  }

  // Both prev and next are defined (prev < next)
  if (prev && next) {
    if (prev >= next) {
      // In degenerate case, append 'm' to prev to ensure prev < result
      return prev + 'm';
    }

    let i = 0;
    let result = '';

    while (true) {
      const pChar = i < prev.length ? prev[i] : '0';
      const nChar = i < next.length ? next[i] : 'z';

      const pVal = getCharVal(pChar);
      const nVal = getCharVal(nChar);

      if (pVal === nVal) {
        result += pChar;
        i++;
        continue;
      }

      const diff = nVal - pVal;

      if (diff > 1) {
        const mid = pVal + Math.floor(diff / 2);
        return result + getValChar(mid);
      }

      // Adjacent values (diff === 1)
      result += pChar;
      i++;

      // Recurse into the remaining space after pChar
      while (i < prev.length) {
        const pSubChar = prev[i];
        const pSubVal = getCharVal(pSubChar);

        if (pSubVal < DIGITS.length - 1) {
          const mid = pSubVal + Math.floor((DIGITS.length - pSubVal) / 2);
          return result + getValChar(mid);
        }

        result += pSubChar;
        i++;
      }

      return result + 'm';
    }
  }

  return 'm';
}

/**
 * Generate initial sequential fractional indices for N items.
 */
export function generateInitialIndices(count: number): string[] {
  const indices: string[] = [];
  let current: string | null = null;
  for (let i = 0; i < count; i++) {
    current = generateFractionalIndex(current, null);
    indices.push(current);
  }
  return indices;
}
