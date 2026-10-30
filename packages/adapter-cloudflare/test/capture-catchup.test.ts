import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { errorCodeOf, scopeId, type ScopeDumpTable, type ScopeId } from '@substrat-run/contracts';
import { SCOPE_COPY_LEASE_MS, ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { CloudflareScopeHost } from './test-host.js';
import { warmControlPlane } from './do-warmup.js';

/**
 * #2450 step 3 on workerd: a copy that needs no quiet moment. Its first page opens a capture that
 * logs every row the source takes afterwards; the pages are staged, then batches of those changes,
 * until the batch read in the same turn as the log ran empty. The copy lands as the source was at
 * that batch, however much it was written to while it was read. Pages are forced small
 * (`maxBytes`), so the writes land between pages that have already read the rows they touch.
 */
const secretBox = webCryptoSecretBox('test-key', new Uint8Array(32).fill(7));

const notes = (n: number): ScopeDumpTable => ({
  name: 'cc_notes',
  ddl: 'CREATE TABLE cc_notes (id TEXT, body TEXT)',
  columns: ['id', 'body'],
  rows: Array.from({ length: n }, (_, i) => [`n${i}`, `body ${i} `.repeat(10)]),
});
// Read by offset: no rowid names its rows, so a write marks the whole table.
const tags = (n: number): ScopeDumpTable => ({
  name: 'cc_tags',
  ddl: 'CREATE TABLE cc_tags (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID',
  columns: ['k', 'v'],
  rows: Array.from({ length: n }, (_, i) => [`k${i}`, `v${i}`]),
});
const audit: ScopeDumpTable = { name: 'cc_audit', ddl: 'CREATE TABLE cc_audit (note TEXT)', columns: ['note'], rows: [] };

type TestStub = {
  testSql(query: string, ...bindings: unknown[]): Promise<Record<string, unknown>[]>;
  testAgeCaptures(ms: number): Promise<void>;
  testElapseCaptureClock(ms: number): Promise<void>;
  testCursorWrite(table: string, column: string): Promise<void>;
};

describe('a copy catches up on the writes its source took while it was read (#2450)', () => {
  let host: CloudflareScopeHost;
  beforeAll(async () => {
    await warmControlPlane(env.PC_CONTROL_PLANE);
    host = new CloudflareScopeHost({ scope: env.PC_V1_SCOPE, controlPlane: env.PC_CONTROL_PLANE, secretBox });
  });

  const stub = (sid: ScopeId) => env.PC_V1_SCOPE.get(env.PC_V1_SCOPE.idFromName(sid)) as unknown as TestStub;
  const sql = (sid: ScopeId, query: string, ...bindings: unknown[]) => stub(sid).testSql(query, ...bindings);
  const seed = async (): Promise<ScopeId> => {
    const sid = scopeId.parse(ulid());
    await host.restoreScopeLocal(sid, [notes(12), tags(6), audit], { sourceScopeId: sid });
    return sid;
  };
  /** The capture's tables and triggers left in `sid`. */
  const captureLeft = async (sid: ScopeId) =>
    (await sql(sid, `SELECT type || ':' || name AS n FROM sqlite_master WHERE name GLOB '_substrat_capture*' ORDER BY n`)).map((r) => r.n);
  /** The vertical's tables as the whole dump reads them, rows sorted (a load renumbers rowids). */
  const vertical = async (sid: ScopeId) =>
    (await host.exportScopeLocal(sid))
      .filter((t) => t.name.startsWith('cc_'))
      .map((t) => ({ name: t.name, rows: t.rows.map((r) => JSON.stringify(r)).sort() }))
      .sort((a, b) => a.name.localeCompare(b.name));

  /**
   * Copy `source` into a fresh scope: every page (a write `betweenPages` after the first), then
   * change batches of at most `maxBytes` (`onPaged` before the first, `betweenBatches` after each
   * but the final one), then the load. Answers the destination and the final batch's revision.
   */
  const copy = async (
    source: ScopeId,
    opts: {
      betweenPages?: () => Promise<unknown>;
      onPaged?: () => Promise<unknown>;
      betweenBatches?: (batch: number) => Promise<unknown>;
      maxBytes?: number;
    } = {},
  ) => {
    const copyId = ulid();
    const dest = scopeId.parse(ulid());
    const stageId = ulid();
    let seq = 0;
    let cursor: string | null = null;
    do {
      const page = await host.exportScopePageLocal(source, cursor, { capture: copyId, maxBytes: 600 });
      expect(await host.stageScopePageLocal(dest, stageId, seq++, page.tables)).toEqual({ staged: true });
      if (seq === 1) await opts.betweenPages?.();
      cursor = page.next;
    } while (cursor !== null);
    expect(seq).toBeGreaterThan(2);
    await opts.onPaged?.();
    for (let batch = 0; ; batch++) {
      const changes = await host.exportScopeChangesLocal(source, copyId, batch, { maxBytes: opts.maxBytes ?? 1 << 20 });
      expect(await host.stageScopeChangesLocal(dest, stageId, seq++, changes.tables)).toEqual({ staged: true });
      if (changes.final) {
        await host.restoreStagedScopeLocal(dest, stageId, { sourceScopeId: source });
        return { dest, revision: changes.revision };
      }
      await opts.betweenBatches?.(batch);
    }
  };

  it('writes between the pages land in the copy', async () => {
    const source = await seed();
    const { dest } = await copy(source, {
      betweenPages: async () => {
        await sql(source, 'UPDATE cc_notes SET body = ? WHERE rowid = 12', 'last, read later');
        await sql(source, `INSERT INTO cc_notes (id, body) VALUES ('n-mid', 'mid')`);
      },
    });
    expect(await vertical(dest)).toEqual(await vertical(source));
  });

  // Each lands once every page is read, so only the catch-up can carry it.
  it.each([
    ['an insert below the pages already read', (s: ScopeId) => sql(s, `INSERT INTO cc_notes (rowid, id, body) VALUES (0, 'n-new', 'new')`)],
    ['an update that moves a row to another rowid', (s: ScopeId) => sql(s, 'UPDATE cc_notes SET rowid = 1000 WHERE rowid = 1')],
    ['a delete', (s: ScopeId) => sql(s, 'DELETE FROM cc_notes WHERE rowid = 1')],
    ['a delete and a reinsert under the same rowid', async (s: ScopeId) => {
      await sql(s, 'DELETE FROM cc_notes WHERE rowid = 1');
      await sql(s, `INSERT INTO cc_notes (rowid, id, body) VALUES (1, 'n-reborn', 'reborn')`);
    }],
    ['a write to a table read by offset', (s: ScopeId) => sql(s, `UPDATE cc_tags SET v = 'changed' WHERE k = 'k0'`)],
  ])('%s lands in the copy', async (_, write) => {
    const source = await seed();
    const { dest } = await copy(source, { onPaged: () => write(source) });
    expect(await vertical(dest)).toEqual(await vertical(source));
    expect(await captureLeft(source)).toEqual([]);
  });

  it('a write between two batches is in the final one; one after it is not, and moves the revision past it', async () => {
    const source = await seed();
    const { dest, revision } = await copy(source, {
      // One row a batch, so the log is not empty after the first.
      maxBytes: 1,
      onPaged: async () => {
        await sql(source, 'DELETE FROM cc_notes WHERE rowid = 2');
        await sql(source, 'DELETE FROM cc_notes WHERE rowid = 3');
      },
      betweenBatches: (batch) => (batch === 0 ? sql(source, `INSERT INTO cc_notes (id, body) VALUES ('n-late', 'late')`) : Promise.resolve()),
    });
    expect(await vertical(dest)).toEqual(await vertical(source));
    expect((await host.loadMarkerLocal(source)).revision).toBe(revision);
    await sql(source, `INSERT INTO cc_notes (id, body) VALUES ('n-after', 'after')`);
    expect((await host.loadMarkerLocal(source)).revision).not.toBe(revision);
    expect(JSON.stringify(await vertical(dest))).not.toContain('n-after');
  });

  it('a batch whose answer was lost is served again; one already staged changes nothing', async () => {
    const source = await seed();
    const copyId = ulid();
    const dest = scopeId.parse(ulid());
    const stageId = ulid();
    const page = await host.exportScopePageLocal(source, null, { capture: copyId });
    expect(page.next).toBeNull();
    await host.stageScopePageLocal(dest, stageId, 0, page.tables);
    await sql(source, 'DELETE FROM cc_notes WHERE rowid = 3');
    const lost = await host.exportScopeChangesLocal(source, copyId, 0, { maxBytes: 1 });
    expect(lost.final).toBe(false);
    await sql(source, `UPDATE cc_notes SET body = 'again' WHERE rowid = 4`);
    const again = await host.exportScopeChangesLocal(source, copyId, 0);
    expect(again.final).toBe(true);
    expect(await host.stageScopeChangesLocal(dest, stageId, 1, again.tables)).toEqual({ staged: true });
    expect(await host.stageScopeChangesLocal(dest, stageId, 1, again.tables)).toEqual({ staged: false });
    await host.restoreStagedScopeLocal(dest, stageId, { sourceScopeId: source });
    expect(await vertical(dest)).toEqual(await vertical(source));
  });

  it('a capture moves no write revision, leaves no trace in a dump, and keeps a table\'s own trigger firing', async () => {
    const source = await seed();
    await sql(source, `CREATE TRIGGER cc_audit_notes AFTER INSERT ON cc_notes BEGIN INSERT INTO cc_audit (note) VALUES (NEW.id); END`);
    const before = await host.loadMarkerLocal(source);
    const copyId = ulid();
    await host.exportScopePageLocal(source, null, { capture: copyId });
    expect(await host.loadMarkerLocal(source)).toEqual(before);
    expect((await host.exportScopeLocal(source)).map((t) => t.name).filter((n) => n.startsWith('_substrat_capture'))).toEqual([]);
    await sql(source, `INSERT INTO cc_notes (id, body) VALUES ('n-audited', 'x')`);
    const marker = await host.loadMarkerLocal(source);
    const changes = await host.exportScopeChangesLocal(source, copyId, 0);
    expect(changes.final).toBe(true);
    // The drain moved nothing either, and it carries the table's trigger's own write.
    expect(await host.loadMarkerLocal(source)).toEqual(marker);
    expect(changes.tables.find((t) => t.name === 'cc_audit')?.rows).toEqual([['n-audited']]);
    expect(await captureLeft(source)).toEqual([]);
    expect(await sql(source, `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'cc_audit_notes'`)).toHaveLength(1);
  });

  it('overlapping captures share the triggers until the last ends, and a stopped copy\'s end takes them', async () => {
    const source = await seed();
    const [a, b] = [ulid(), ulid()];
    await host.exportScopePageLocal(source, null, { capture: a });
    await host.exportScopePageLocal(source, null, { capture: b });
    await sql(source, 'DELETE FROM cc_notes WHERE rowid = 5');
    const first = await host.exportScopeChangesLocal(source, a, 0);
    expect(first.final).toBe(true);
    expect(first.tables.find((t) => t.name === 'cc_notes')?.deleted).toEqual([5]);
    // b is still open, so the triggers stay.
    expect(await captureLeft(source)).toContain('trigger:_substrat_capture_d_cc_notes');
    expect(await host.endScopeCaptureLocal(source, b)).toEqual({ ended: true });
    expect(await captureLeft(source)).toEqual([]);
    const gone = await host.exportScopeChangesLocal(source, b, 1).catch((e: unknown) => e);
    expect(errorCodeOf(gone)).toBe('precondition_failed');
  });

  it('a capture idle for a lease ends before the next write, which logs nothing', async () => {
    const source = await seed();
    const copyId = ulid();
    await host.exportScopePageLocal(source, null, { capture: copyId });
    await stub(source).testAgeCaptures(SCOPE_COPY_LEASE_MS - 60_000);
    await sql(source, `INSERT INTO cc_notes (id, body) VALUES ('n-kept', 'x')`);
    expect(await sql(source, 'SELECT copy_id FROM _substrat_capture')).toEqual([{ copy_id: copyId }]);
    await stub(source).testAgeCaptures(120_000);
    await sql(source, `INSERT INTO cc_notes (id, body) VALUES ('n-unlogged', 'x')`);
    const gone = await host.exportScopeChangesLocal(source, copyId, 0).catch((e: unknown) => e);
    expect(errorCodeOf(gone)).toBe('precondition_failed');
    // The triggers and tables go in a turn of their own.
    await vi.waitFor(async () => expect(await captureLeft(source)).toEqual([]));
  });

  it('an expiry under a module\'s open read cursor neither fails the write nor drops anything under it', async () => {
    const source = await seed();
    await host.exportScopePageLocal(source, null, { capture: ulid() });
    await stub(source).testAgeCaptures(SCOPE_COPY_LEASE_MS + 60_000);
    await stub(source).testCursorWrite('cc_notes', 'body');
    expect(await sql(source, `SELECT COUNT(*) AS n FROM cc_notes WHERE body = 'x'`)).toEqual([{ n: 12 }]);
    await vi.waitFor(async () => expect(await captureLeft(source)).toEqual([]));
  });

  it('a load under an open capture takes it, and writes past its lease still land', async () => {
    const source = await seed();
    await host.exportScopePageLocal(source, null, { capture: ulid() });
    await host.restoreScopeLocal(source, [notes(3), tags(1), audit], { sourceScopeId: source });
    // As the object held the clock before the load, a lease later.
    await stub(source).testElapseCaptureClock(SCOPE_COPY_LEASE_MS + 60_000);
    await sql(source, `INSERT INTO cc_notes (id, body) VALUES ('w1', 'x')`);
    await sql(source, `INSERT INTO cc_notes (id, body) VALUES ('w2', 'x')`);
    expect(await sql(source, `SELECT COUNT(*) AS n FROM cc_notes`)).toEqual([{ n: 5 }]);
    expect(await captureLeft(source)).toEqual([]);
  });

  it('a table dropped and made again with the same schema ends the capture and refuses it', async () => {
    const source = await seed();
    const copyId = ulid();
    await host.exportScopePageLocal(source, null, { capture: copyId });
    await sql(source, 'DROP TABLE cc_notes');
    await sql(source, notes(0).ddl);
    await sql(source, `INSERT INTO cc_notes (id, body) VALUES ('z1', 'other')`);
    const refused = await host.exportScopeChangesLocal(source, copyId, 0).catch((e: unknown) => e);
    expect(errorCodeOf(refused)).toBe('precondition_failed');
    expect(await captureLeft(source)).toEqual([]);
  });

  it('a table added while the copy reads ends the capture and refuses it', async () => {
    const source = await seed();
    const copyId = ulid();
    await host.exportScopePageLocal(source, null, { capture: copyId });
    await sql(source, 'CREATE TABLE cc_late (x TEXT)');
    const refused = await host.exportScopeChangesLocal(source, copyId, 0).catch((e: unknown) => e);
    expect(errorCodeOf(refused)).toBe('precondition_failed');
    expect(String((refused as Error).message)).toContain('schema changed');
    expect(await captureLeft(source)).toEqual([]);
  });

  // A row a REPLACE resolution deletes fires no delete trigger, so each unique key's BEFORE
  // trigger logs it. Every key shape, against every way a write can meet an existing row on it.
  const KEYS: [string, { ddl: string; index?: string; key: (n: number) => string; rowKey: (n: number) => string | null }][] = [
    ['a text primary key', { ddl: 'CREATE TABLE rk (id TEXT, code TEXT PRIMARY KEY, v TEXT)', key: (n) => `'c${n}'`, rowKey: (n) => `c${n}` }],
    ['a UNIQUE constraint', { ddl: 'CREATE TABLE rk (id TEXT, code TEXT UNIQUE, v TEXT)', key: (n) => `'c${n}'`, rowKey: (n) => `c${n}` }],
    ['a unique index', { ddl: 'CREATE TABLE rk (id TEXT, code TEXT, v TEXT)', index: 'CREATE UNIQUE INDEX rk_code ON rk (code)', key: (n) => `'c${n}'`, rowKey: (n) => `c${n}` }],
    ['a composite key', { ddl: 'CREATE TABLE rk (id TEXT, code TEXT, v TEXT, UNIQUE (id, code))', key: (n) => `'c${n}'`, rowKey: (n) => `c${n}` }],
    // The column compares BINARY and the index NOCASE: only the index's collation finds the conflict.
    ['a NOCASE index, case-only', { ddl: 'CREATE TABLE rk (id TEXT, code TEXT, v TEXT)', index: 'CREATE UNIQUE INDEX rk_code ON rk (code COLLATE NOCASE)', key: (n) => `'C${n}'`, rowKey: (n) => `c${n}` }],
    ['a NULL key', { ddl: 'CREATE TABLE rk (id TEXT, code TEXT UNIQUE, v TEXT)', key: () => 'NULL', rowKey: () => null }],
  ];
  const WRITES: [string, (k: (n: number) => string) => string][] = [
    ['INSERT OR REPLACE', (k) => `INSERT OR REPLACE INTO rk (id, code, v) VALUES ('a', ${k(1)}, 'replaced')`],
    ['REPLACE INTO', (k) => `REPLACE INTO rk (id, code, v) VALUES ('a', ${k(2)}, 'replaced')`],
    ['UPDATE OR REPLACE onto another key', (k) => `UPDATE OR REPLACE rk SET code = ${k(3)} WHERE v = 'v0'`],
    ['an upsert', (k) => `INSERT INTO rk (id, code, v) VALUES ('a', ${k(1)}, 'up') ON CONFLICT DO UPDATE SET v = excluded.v`],
    ['INSERT OR IGNORE', (k) => `INSERT OR IGNORE INTO rk (id, code, v) VALUES ('a', ${k(1)}, 'ignored')`],
  ];
  it.each(KEYS.flatMap(([keyName, key]) => WRITES.map(([writeName, write]) => [`${writeName} on ${keyName}`, key, write] as const)))(
    '%s lands as the source holds it',
    async (_, key, write) => {
      const source = scopeId.parse(ulid());
      const rk: ScopeDumpTable = {
        name: 'rk', ddl: key.ddl, columns: ['id', 'code', 'v'],
        rows: Array.from({ length: 4 }, (__, n) => ['a', key.rowKey(n), `v${n}`]),
      };
      await host.restoreScopeLocal(source, [rk], { sourceScopeId: source });
      if (key.index) await sql(source, key.index);
      const copyId = ulid();
      const dest = scopeId.parse(ulid());
      const stageId = ulid();
      const page = await host.exportScopePageLocal(source, null, { capture: copyId });
      expect(page.next).toBeNull();
      await host.stageScopePageLocal(dest, stageId, 0, page.tables);
      await sql(source, write(key.key));
      const changes = await host.exportScopeChangesLocal(source, copyId, 0);
      expect(changes.final).toBe(true);
      await host.stageScopeChangesLocal(dest, stageId, 1, changes.tables);
      await host.restoreStagedScopeLocal(dest, stageId, { sourceScopeId: source });
      const rows = async (sid: ScopeId) => (await sql(sid, 'SELECT id, code, v FROM rk ORDER BY v, code')).map((r) => JSON.stringify(r));
      expect(await rows(dest)).toEqual(await rows(source));
    },
  );

  it('a unique index on an expression refuses a capture, leaving nothing; the page without one still reads', async () => {
    const source = await seed();
    await sql(source, 'CREATE UNIQUE INDEX cc_notes_lower ON cc_notes (lower(id))');
    const refused = await host.exportScopePageLocal(source, null, { capture: ulid() }).catch((e: unknown) => e);
    expect(errorCodeOf(refused)).toBe('precondition_failed');
    expect(await captureLeft(source)).toEqual([]);
    // What a caller falls back to: the copy that needs a quiet moment.
    expect((await host.exportScopePageLocal(source, null)).tables.map((t) => t.name)).toContain('cc_notes');
  });
});
