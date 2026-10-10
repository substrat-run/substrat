/**
 * #1773: `hr/list-employees`, whose handler the platform now derives, answers what the
 * hand-written handler it replaced answered — the check plus `ctx.page` over employees. The
 * oracle is the rows on the scope's own database, the table named as a literal.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from '@substrat-run/contracts';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { buildDemoHost, seedDemo, type DemoWorld } from '../src/index.js';

type Row = Record<string, unknown>;

let dir: string;
let host: SqliteScopeHost;
let w: DemoWorld;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'meridian-derived-pins-'));
  host = buildDemoHost(dir);
  w = await seedDemo(host, dir);
});
afterAll(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('derived reads answer what the handlers they replaced answered (#1773)', () => {
  it('hr/list-employees: the page is the rows', async () => {
    const hedda = await host.getScope(w.hedda, w.t1, w.sSe);
    const page = await hedda.invoke<Page<Row>>('hr/list-employees', { limit: 100 });
    const db = new Database(join(dir, `${w.t1}__${w.sSe}.sqlite`), { readonly: true });
    const rows = new Map((db.prepare('SELECT * FROM hr_employees').all() as Row[]).map((r) => [r.id, r]));
    db.close();
    expect(page.entries.length).toBe(rows.size);
    expect(page.entries).toStrictEqual(page.entries.map((e) => rows.get(e.id)));
  });
});
