/**
 * Which lines of a changed file the change adds or alters, so a finding can be held to one
 * (checklist.md: "A finding must point at a line the change adds or alters").
 *
 * Myers' O(ND) line diff, forward with a trace of each round's furthest points, then walked back.
 * Memory is O(D²) in the number of edits, so a diff past `maxEdits` stops and answers `null`: the
 * caller then counts every line as changed, which over-admits rather than drops a real finding.
 */

/** Changed lines of the new text (1-based), and where lines were removed (after new line n; 0 is before line 1). */
export interface LineChanges {
  readonly changed: ReadonlySet<number>;
  readonly removedAfter: readonly number[];
}

export const LINE_DIFF_MAX_EDITS = 2_000;

export function lineChanges(before: string, after: string, maxEdits = LINE_DIFF_MAX_EDITS): LineChanges | null {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;
  const limit = Math.min(n + m, maxEdits);
  const trace: Int32Array[] = [];
  // v[k] for diagonal k = x - y, stored at index k + offset.
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  let found = -1;
  for (let d = 0; d <= limit && found < 0; d++) {
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  if (found < 0) return null;
  const changed = new Set<number>();
  const removed = new Set<number>();
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const snapshot = trace[d]!;
    const at = (k: number) => snapshot[k + d]!;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > (down ? prevX : prevX + 1) && y > (down ? prevY + 1 : prevY)) { x--; y--; }
    if (down) changed.add(prevY + 1); // b[prevY] inserted: new line prevY + 1
    else removed.add(prevY); // a[prevX] removed, after new line prevY
    x = prevX;
    y = prevY;
  }
  return { changed, removedAfter: [...removed].sort((p, q) => p - q) };
}
