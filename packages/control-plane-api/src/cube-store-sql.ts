/**
 * Closed blocks of counts, kept in SQLite (#1877) — the store behind `cachedSource`, over
 * any SQL surface that runs a statement and hands back rows: a Durable Object's
 * `ctx.storage.sql` in production, `better-sqlite3` in a test.
 *
 * Two facts shape it:
 *
 * - **A Durable Object refuses a row past about 2 MB** (`SQLITE_TOOBIG`). A busy script's
 *   block can hold more than that, so a block is split into parts of bounded size and
 *   stitched back on read.
 * - **A write can stop between parts.** Each part records how many parts the block has,
 *   and a block whose parts are not all there is read as MISSING, never as complete — so
 *   a torn write costs one recount, and can never be cached as a smaller answer.
 *
 * Blocks are kept as long as the logs they were counted from (7 days in Workers Logs), with
 * a day's margin; older ones are pruned on write.
 */
import type { CubeStore, StoredBlock } from './aggregate-source.js';

/** The SQL surface the store needs — one statement, positional params, rows back. */
export interface SqlExecLike {
  exec(sql: string, ...params: unknown[]): { toArray(): Array<Record<string, unknown>> };
}

/** The largest part, in characters of JSON — well under the ~2 MB row limit. */
export const CUBE_PART_CHARS = 500_000;

/** How long a block is kept after it starts. */
export const CUBE_RETENTION_MS = 8 * 24 * 3_600_000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS cube_blocks (
     key TEXT NOT NULL,
     part INTEGER NOT NULL,
     parts INTEGER NOT NULL,
     block_start INTEGER NOT NULL,
     estimated INTEGER NOT NULL,
     rows TEXT NOT NULL,
     PRIMARY KEY (key, part)
   )`,
  'CREATE INDEX IF NOT EXISTS cube_blocks_start ON cube_blocks (block_start)',
];

/** Split a block's rows into JSON arrays no longer than `CUBE_PART_CHARS` each. */
export function splitRows(rows: readonly unknown[]): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  let size = 2;
  for (const row of rows) {
    const text = JSON.stringify(row);
    if (current.length > 0 && size + text.length + 1 > CUBE_PART_CHARS) {
      parts.push(`[${current.join(',')}]`);
      current = [];
      size = 2;
    }
    current.push(text);
    size += text.length + 1;
  }
  parts.push(`[${current.join(',')}]`);
  return parts;
}

export function sqlCubeStore(sql: SqlExecLike, opts: { now?: () => number } = {}): CubeStore {
  const now = opts.now ?? (() => Date.now());
  for (const statement of SCHEMA) sql.exec(statement);
  return {
    async get(keys) {
      const out = new Map<string, StoredBlock<unknown>>();
      if (keys.length === 0) return out;
      const rows = sql
        .exec(
          'SELECT key, part, parts, estimated, rows FROM cube_blocks WHERE key IN (SELECT value FROM json_each(?)) ORDER BY key, part',
          JSON.stringify(keys),
        )
        .toArray();
      const byKey = new Map<string, Array<Record<string, unknown>>>();
      for (const r of rows) {
        const k = String(r['key']);
        byKey.set(k, [...(byKey.get(k) ?? []), r]);
      }
      for (const [key, parts] of byKey) {
        const expected = Number(parts[0]!['parts']);
        // A torn write: not every part is there, so the block is not known — recount it.
        if (parts.length !== expected || parts.some((p, i) => Number(p['part']) !== i)) continue;
        out.set(key, {
          rows: parts.flatMap((p) => JSON.parse(String(p['rows'])) as unknown[]),
          estimated: parts.some((p) => Number(p['estimated']) === 1),
        });
      }
      return out;
    },
    async put(key, block, blockStart) {
      const parts = splitRows(block.rows);
      sql.exec('DELETE FROM cube_blocks WHERE key = ?', key);
      parts.forEach((rows, part) => {
        sql.exec(
          'INSERT INTO cube_blocks (key, part, parts, block_start, estimated, rows) VALUES (?, ?, ?, ?, ?, ?)',
          key,
          part,
          parts.length,
          blockStart,
          block.estimated ? 1 : 0,
          rows,
        );
      });
      sql.exec('DELETE FROM cube_blocks WHERE block_start < ?', now() - CUBE_RETENTION_MS);
    },
  };
}
