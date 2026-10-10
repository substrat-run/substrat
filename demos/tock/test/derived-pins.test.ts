/**
 * #1773: the two tock operations whose handler the platform now derives answer what the
 * hand-written handler they replaced answered.
 *
 * `tock/get-run` was the narrowed check plus `SELECT *` by id with `run not found: <id>`;
 * `tock/list-sources` was the check plus `ctx.page` over sources. The oracle is the row the old
 * body read, straight off the workspace's own database, with the table named as a literal.
 */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorCodeOf, type Page } from '@substrat-run/contracts';
import type { ScopeHost } from '@substrat-run/kernel';
import { buildHost, seed, type World } from '../src/seed.js';

type Row = Record<string, unknown>;

let dir: string;
let host: ScopeHost;
let world: World;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tock-derived-pins-'));
  host = buildHost(dir);
  world = await seed(host);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const as = (who: 'ines' | 'tomas') => host.getScope(world[who].principal, world.tenant, world.scope);

function rows(table: string): Row[] {
  const db = new Database(join(dir, `${world.tenant}__${world.scope}.sqlite`), { readonly: true });
  try {
    return db.prepare(`SELECT * FROM ${table}`).all() as Row[];
  } finally {
    db.close();
  }
}

describe('derived reads answer what the handlers they replaced answered (#1773)', () => {
  it('tock/list-sources and tock/get-run: the rows the old bodies read, and the same not_found', async () => {
    const ines = await as('ines');
    await ines.invoke('tock/declare-source', { key: 'pinned-cdn', title: 'Pinned CDN', expectedCadence: 'daily' });
    const tomas = await as('tomas');
    const run = await tomas.invoke<{ id: string }>('tock/receive-run', {
      sourceKey: 'pinned-cdn',
      filename: 'pinned.log',
      byteSize: 1,
      contentHash: 'sha256:pin',
      storageKey: 'runs/pinned.log',
      format: 'csv',
      delimiter: ',',
      timeField: 'occurred_at',
      subjectField: 'subject',
      periodFrom: '2026-03-14T00:00:00.000Z',
      periodTo: '2026-03-15T00:00:00.000Z',
    });

    const sources = await ines.invoke<Page<Row>>('tock/list-sources', { limit: 100 });
    const byKey = new Map(rows('tock_sources').map((r) => [r.key, r]));
    expect(sources.entries.length).toBe(byKey.size);
    expect(sources.entries).toStrictEqual(sources.entries.map((s) => byKey.get(s.key)));

    const got = await tomas.invoke('tock/get-run', { runId: run.id });
    expect(got).toStrictEqual(rows('tock_runs').find((r) => r.id === run.id));
    const missing = await tomas.invoke('tock/get-run', { runId: 'nope' }).catch((e: unknown) => e);
    expect([errorCodeOf(missing), (missing as Error).message]).toEqual(['not_found', 'run not found: nope']);
  });
});
