/**
 * #1833 (Copilot review, PR #1843): `manyfold/list-entries` and `manyfold/list-delivery`
 * page with a composite keyset predicate over (updated_at, id) / (published_at, entry_id).
 * The predicate is correct with or without an index — this test is what tells the two
 * apart: it proves SQLite SEEKS the index the migration adds (migrations.ts #0003)
 * rather than rescanning every row a prior page already answered.
 *
 * `EXPLAIN QUERY PLAN` against the exact query text `listEntriesSql`/`listDeliverySql`
 * build — imported, not retyped, so this cannot pass by testing a copy that happens to
 * be faster than the real thing.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { buildDemoHost, seedDemo, listEntriesSql, listDeliverySql, type ManyfoldWorld } from '../src/index.js';

let dir: string;
let host: SqliteScopeHost;
let w: ManyfoldWorld;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'substrat-manyfold-plan-'));
  host = buildDemoHost(dir);
  w = await seedDemo(host, dir);
});

afterAll(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The plan SQLite would actually pick, read off cafe's own file — a raw
 *  read-only connection alongside the host, same as `scenario.test.ts`'s test 1. */
function planFor(sql: string, params: readonly (string | number)[]): string {
  const db = new Database(join(dir, `${w.t1}__${w.cafe}.sqlite`), { readonly: true });
  try {
    return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[])
      .map((r) => r.detail)
      .join('\n');
  } finally {
    db.close();
  }
}

describe('manyfold list reads seek the page index, not a rescan (#1833)', () => {
  it('list-entries: a cursor page seeks manyfold_entry_updated_id', () => {
    const plan = planFor(listEntriesSql(['(updated_at, id) < (?, ?)'], 'DESC'), [
      '2026-01-01T00:00:00.000Z',
      'x',
      20,
    ]);
    expect(plan).toMatch(/USING (COVERING )?INDEX manyfold_entry_updated_id/);
    // The failure mode this guards: `SCAN manyfold_entry` with no index named at all —
    // every row walked, the cursor applied as a plain filter afterwards.
    expect(plan).not.toMatch(/^SCAN manyfold_entry$/m);
  });

  it('list-entries: the ascending direction seeks the same index', () => {
    const plan = planFor(listEntriesSql(['(updated_at, id) > (?, ?)'], 'ASC'), [
      '2026-01-01T00:00:00.000Z',
      'x',
      20,
    ]);
    expect(plan).toMatch(/USING (COVERING )?INDEX manyfold_entry_updated_id/);
  });

  it('list-delivery: a cursor page seeks manyfold_delivery_published_id', () => {
    const plan = planFor(listDeliverySql(['(published_at, entry_id) < (?, ?)'], 'DESC'), [
      '2026-01-01T00:00:00.000Z',
      'x',
      20,
    ]);
    expect(plan).toMatch(/USING (COVERING )?INDEX manyfold_delivery_published_id/);
    expect(plan).not.toMatch(/^SCAN manyfold_delivery$/m);
  });
});
