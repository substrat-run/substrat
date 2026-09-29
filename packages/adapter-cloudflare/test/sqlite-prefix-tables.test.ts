import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { scopeId, type ScopeDumpTable } from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { CloudflareScopeHost } from '../src/host.js';
import { ControlPlaneDO } from '../src/control-plane-do.js';
import { warmControlPlane } from './do-warmup.js';

/**
 * #1881 on workerd, where hosted exports run: `NOT LIKE 'sqlite_%'` read `_` as a wildcard, so a
 * vertical table named `sqlitedata` fell out of the ScopeDO's export and its restore's drop
 * sweep, and out of the directory's. Twin: `sqlite_sequence` stays out. Asserts only on tables
 * this file planted.
 */
const table = (name: string, rows: unknown[][]): ScopeDumpTable => ({
  name,
  ddl: `CREATE TABLE ${name} (id INTEGER PRIMARY KEY, v TEXT)`,
  columns: ['id', 'v'],
  rows,
});
const SQLITEDATA = table('sqlitedata', [[1, 'a'], [2, 'b']]);
const SQLITEX = table('sqliteX', [[1, 'x']]);
const AUTO: ScopeDumpTable = {
  name: 'sqlitecounter',
  ddl: 'CREATE TABLE sqlitecounter (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)',
  columns: ['id', 'v'],
  rows: [[1, 'a']],
};
const mine = (tables: ScopeDumpTable[]) => tables.filter((t) => ['sqlitedata', 'sqliteX'].includes(t.name));

/** The directory DO's own instance, reached the way directory-rebuild.test.ts does. */
const inCp = <T>(stub: DurableObjectStub<undefined>, fn: (i: ControlPlaneDO) => T | Promise<T>) =>
  runInDurableObject(stub, (i) => fn(i as unknown as ControlPlaneDO));

beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

describe('tables named like the sqlite_ prefix, on the ScopeDO (#1881)', () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });

  it('round-trips export → restore → export byte for byte, and a restore without them drops them', async () => {
    const s = scopeId.parse(ulid());
    await host.restoreScopeLocal(s, [SQLITEDATA, SQLITEX]);
    const first = await host.exportScopeLocal(s);
    expect(mine(first).map((t) => t.name).sort()).toEqual(['sqliteX', 'sqlitedata']);
    await host.restoreScopeLocal(s, first);
    const second = await host.exportScopeLocal(s);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(mine(second).find((t) => t.name === 'sqlitedata')?.rows).toEqual(SQLITEDATA.rows);
    // The drop sweep: a dump without them replaces, rather than keeps, the old copies.
    await host.restoreScopeLocal(s, [table('sqlitekeep', [[1, 'k']])]);
    const after = await host.exportScopeLocal(s);
    expect(mine(after)).toEqual([]);
    expect(after.map((t) => t.name)).toContain('sqlitekeep');
  });

  it('twin: sqlite_sequence is still left out of the dump', async () => {
    const s = scopeId.parse(ulid());
    await host.restoreScopeLocal(s, [AUTO]);
    const names = (await host.exportScopeLocal(s)).map((t) => t.name);
    expect(names).toContain('sqlitecounter');
    expect(names).not.toContain('sqlite_sequence');
  });
});

describe('tables named like the sqlite_ prefix, in the directory DO (#1881)', () => {
  it('exportDump keeps sqlitedata, importDump replaces it, sqlite_sequence stays out', async () => {
    const stub = env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName(`prefix-${ulid()}`));
    const base = await inCp(stub, (i) => i.exportDump());
    await inCp(stub, (i) => i.importDump([...base, SQLITEDATA, AUTO]));
    const withIt = await inCp(stub, (i) => i.exportDump());
    expect(mine(withIt).map((t) => t.name)).toEqual(['sqlitedata']);
    expect(withIt.map((t) => t.name)).toContain('sqlitecounter');
    expect(withIt.map((t) => t.name)).not.toContain('sqlite_sequence');
    await inCp(stub, (i) => i.importDump(base));
    const gone = await inCp(stub, (i) => i.exportDump());
    expect(mine(gone)).toEqual([]);
  });
});
