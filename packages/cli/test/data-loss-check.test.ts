import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import {
  checkMigrationDataLoss,
  dataLossCheckRequired,
  formatDataLossCheck,
  openInMemorySqlite,
  type ReplayInputs,
} from '../src/data-loss-check.js';

/**
 * #2321 — the data-loss check a push makes before upload, on its own: the vertical's kernel
 * reached as a value (here the workspace kernel's build, which is what a fixture vertical links),
 * the SQLite opener and the spine injected. The push-level half, through the real `push()`, is in
 * push-data-loss.test.ts.
 */
const kernelDist = join(fileURLToPath(new URL('../../kernel', import.meta.url)), 'dist', 'index.js');
const kernelBuilt = existsSync(kernelDist);
const kernel = kernelBuilt ? ((await import(pathToFileURL(kernelDist).href)) as Record<string, unknown>) : null;

type Migration = { version: string; sql: string; moves?: Record<string, string>; discards?: Record<string, string> };
const INIT: Migration = { version: '0001', sql: 'CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT);' };
const inputs = (migrations: Migration[], over: Partial<ReplayInputs> = {}): ReplayInputs => ({
  kernel,
  modules: [{ manifest: { id: 'notes' }, migrations }],
  spineDdl: async () => undefined,
  ...over,
});
const run = async (i: ReplayInputs, opts: Parameters<typeof checkMigrationDataLoss>[1] = {}) => {
  const log: string[] = [];
  const warn: string[] = [];
  const result = checkMigrationDataLoss(i, { log: (m) => log.push(m), warn: (m) => warn.push(m), ...opts });
  return { result, log, warn };
};

describe.runIf(kernelBuilt)("the push's data-loss check, through the vertical's own kernel", () => {
  it('refuses an undeclared destructive migration with the fence message and the remedy', async () => {
    const { result } = await run(inputs([INIT, { version: '0002', sql: 'DROP TABLE notes;' }]));
    await expect(result).rejects.toThrow(/data-loss check: REFUSED — migration notes@0002 would lose data/);
    await expect(result).rejects.toThrow(/discards: \{ 'notes': '<why this data may go>' \}/);
  });

  it('passes the declared version, printing each declaration with its reason', async () => {
    const { result, log, warn } = await run(inputs([INIT, { version: '0002', sql: 'DROP TABLE notes;', discards: { notes: 'retired' } }]));
    await expect(result).resolves.toEqual({ status: 'passed', authored: 2 });
    expect(log).toEqual([
      'declared  notes@0002 discards notes: retired',
      'data-loss check: PASSED (2 authored migration(s) replayed against a populated scope)',
    ]);
    expect(warn).toEqual([]);
  });

  it('passes an additive migration', async () => {
    const { result } = await run(inputs([INIT, { version: '0002', sql: 'ALTER TABLE notes ADD COLUMN title TEXT;' }]));
    await expect(result).resolves.toEqual({ status: 'passed', authored: 2 });
  });

  it('a refusal is a refusal even under --require-data-loss-check, and without it', async () => {
    const drop = inputs([INIT, { version: '0002', sql: 'DROP TABLE notes;' }]);
    await expect((await run(drop, { require: true })).result).rejects.toThrow(/REFUSED/);
  });

  it('INCOMPLETE says how many migrations went unchecked after the one that could not run, and goes on', async () => {
    const { result, warn } = await run(
      inputs([
        INIT,
        { version: '0002', sql: "UPDATE notes SET body = json_extract(body, '$.text');" },
        { version: '0003', sql: 'DROP TABLE notes;' },
      ]),
    );
    await expect(result).resolves.toMatchObject({ status: 'incomplete', authored: 3, notReplayed: 2, key: 'notes@0002' });
    expect(warn[0]).toMatch(/^⚠ notes@0002 could not be replayed on synthetic data: .*json/i);
    expect(warn.at(-1)).toBe(
      '⚠ data-loss check: INCOMPLETE (2 of 3 authored migration(s) were not replayed after notes@0002 failed) — the fence still refuses at promote',
    );
  });

  it('INCOMPLETE refuses under --require-data-loss-check', async () => {
    const i = inputs([INIT, { version: '0002', sql: "UPDATE notes SET body = json_extract(body, '$.x');" }]);
    await expect((await run(i, { require: true })).result).rejects.toThrow(/INCOMPLETE.*\n--require-data-loss-check/);
  });

  it('builds the spine it is handed first; without it a spine read is INCOMPLETE and names the remedy', async () => {
    const reads: Migration = { version: '0002', sql: 'INSERT INTO notes (id, body) SELECT id, kind FROM _substrat_things;' };
    const spine = 'CREATE TABLE _substrat_things (id TEXT, kind TEXT);';
    await expect((await run(inputs([INIT, reads], { spineDdl: async () => spine }))).result).resolves.toMatchObject({ status: 'passed' });
    const without = await run(inputs([INIT, reads]));
    await expect(without.result).resolves.toMatchObject({ status: 'incomplete' });
    expect(without.warn.join('\n')).toContain('add @substrat-run/adapter-sqlite as a devDependency');
  });

  it('SKIPPED when node:sqlite is unavailable — loud on stderr, never silent, and not a refusal by default', async () => {
    const { result, warn, log } = await run(inputs([INIT]), { openSqlite: async () => undefined });
    const check = await result;
    expect(check).toMatchObject({ status: 'skipped' });
    expect(warn).toEqual([`⚠ data-loss check: SKIPPED (node:sqlite unavailable on Node ${process.versions.node}; it needs 22.13 or later) — the fence still refuses at promote`]);
    expect(log).toEqual([]);
    await expect((await run(inputs([INIT]), { openSqlite: async () => undefined, require: true })).result).rejects.toThrow(/SKIPPED \(node:sqlite unavailable/);
  });

  it('nothing authored needs no SQLite at all', async () => {
    const openSqlite = vi.fn(async () => undefined);
    const { result } = await run(inputs([]), { openSqlite, require: true });
    await expect(result).resolves.toEqual({ status: 'passed', authored: 0 });
    expect(openSqlite).not.toHaveBeenCalled();
  });

  it('replays into one fresh database it opened itself — never anything of the vertical\'s', async () => {
    const opened: unknown[] = [];
    const openSqlite = async () => {
      const open = await openInMemorySqlite();
      return () => {
        const db = open!();
        opened.push(db);
        return db;
      };
    };
    await (await run(inputs([INIT]), { openSqlite })).result;
    expect(opened).toHaveLength(1);
  });
});

describe('a kernel this CLI cannot call is SKIPPED, by feature detection', () => {
  const skipped = async (k: unknown) => {
    const { result, warn } = await run(inputs([INIT], { kernel: k }));
    await expect(result).resolves.toMatchObject({ status: 'skipped' });
    return warn.join('\n');
  };
  it('no kernel resolves', async () => {
    expect(await skipped(null)).toContain('no @substrat-run/kernel resolves from the vertical');
  });
  it('a kernel from before the replay', async () => {
    expect(await skipped({ moduleMigrations: () => [] })).toContain('has no migration replay (upgrade it)');
  });
  it('a kernel with a replay API this CLI does not know', async () => {
    expect(await skipped({ MIGRATION_REPLAY_API: 2, replayMigrations: () => ({}) })).toContain('replay API 2, this CLI calls 1 (upgrade the CLI)');
  });
  it('a kernel whose replay returns an outcome of another shape', async () => {
    const odd = { MIGRATION_REPLAY_API: 1, replayMigrations: () => ({ ok: true }) };
    expect(await skipped(odd)).toContain('returned a replay outcome this CLI does not recognise');
  });
});

describe('the strict switch', () => {
  it('is the flag, or SUBSTRAT_REQUIRE_DATA_LOSS_CHECK=1 — nothing else', () => {
    expect(dataLossCheckRequired(['push', '--require-data-loss-check'], {})).toBe(true);
    expect(dataLossCheckRequired(['push'], { SUBSTRAT_REQUIRE_DATA_LOSS_CHECK: '1' })).toBe(true);
    expect(dataLossCheckRequired(['push'], { SUBSTRAT_REQUIRE_DATA_LOSS_CHECK: '0' })).toBe(false);
    expect(dataLossCheckRequired(['push'], {})).toBe(false);
  });

  it('formats every outcome as one summary line', () => {
    expect(formatDataLossCheck({ status: 'passed', authored: 3 })).toBe(
      'data-loss check: PASSED (3 authored migration(s) replayed against a populated scope)',
    );
    expect(formatDataLossCheck({ status: 'skipped', why: 'x' })).toBe('data-loss check: SKIPPED (x) — the fence still refuses at promote');
  });
});

describe('node:sqlite, in memory', () => {
  it('opens a working database where this Node has it, swallowing only the experimental notice', async () => {
    const open = await openInMemorySqlite();
    expect(open).toBeDefined();
    const db = open!();
    db.exec('CREATE TABLE t (n INTEGER); INSERT INTO t VALUES (7);');
    expect(db.prepare('SELECT n FROM t').all()).toEqual([{ n: 7 }]);
  });

  it('restores process.emitWarning, so other warnings still reach the user', async () => {
    const before = process.emitWarning;
    await openInMemorySqlite();
    expect(process.emitWarning).toBe(before);
  });
});
