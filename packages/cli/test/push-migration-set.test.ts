import { beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { flattenDeclaredMigrations } from '../src/push.js';
import { kernelBuilt } from './push-harness.js';

/**
 * #2349: what a push stores is what a scope host holds its pending migrations to. The CLI's own
 * `flattenDeclaredMigrations` output, with the derived steps present (a CLI that resolved the
 * vertical's kernel) or absent (one that did not, or an older one), goes through the kernel's
 * `migrationSetDigest` — what the uploader injects — and the host's `migrationSetDivergence`
 * over the same modules must accept it. The kernel is read from the workspace, as a vertical's
 * own kernel is (ci-scope READS lists the edge), since the Apache-2.0 CLI declares none.
 */
/** The kernel functions this suite calls, typed here because the CLI declares no kernel. */
interface Kernel {
  moduleMigrations(registration: never): { version: string; sql: string }[];
  migrationSteps(registration: never): Promise<readonly unknown[]>;
  isDerivedMigrationVersion(version: string): boolean;
  migrationSetDigest(migrations: readonly { moduleId: string; version: string; sql: string }[]): Promise<string>;
  migrationSetDivergence(modules: Iterable<{ id: string; steps: Promise<readonly unknown[]> }>, stored: string): Promise<string | null>;
}
const kernelEntry = pathToFileURL(join(fileURLToPath(new URL('../../kernel', import.meta.url)), 'dist', 'index.js')).href;

const TABLE = { version: '0001-init', sql: 'CREATE TABLE ticket (id TEXT PRIMARY KEY, title TEXT, status TEXT, created_at TEXT);' };
const NEXT = { version: '0002-note', sql: 'ALTER TABLE ticket ADD COLUMN note TEXT;' };
const searchables = [{ entityType: 'ticket', fields: ['title'], table: 'ticket', idColumn: 'id', tokenizer: 'unicode61' }];
const lists = [{ entityType: 'ticket', sortable: ['created_at', 'id'], filterable: ['status'], table: 'ticket', idColumn: 'id' }];
const entityStates = [{ entityType: 'ticket', archivePermission: 'ticket:archive', trashPermission: 'ticket:trash', table: 'ticket', idColumn: 'id' }];

/** One module per declaration kind, and one with all three. */
const modules = [
  { manifest: { id: 'states', entityStates }, migrations: [TABLE, NEXT] },
  { manifest: { id: 'search', searchables }, migrations: [TABLE] },
  { manifest: { id: 'lists', lists }, migrations: [TABLE, NEXT] },
  { manifest: { id: 'mixed', searchables, lists, entityStates }, migrations: [TABLE] },
];
const permissions = (mods: typeof modules) => ({ modules: mods, roles: [] }) as never;

describe.runIf(kernelBuilt)('the stored set a push makes, against the set a scope host registers (#2349)', () => {
  let kernel: Kernel;
  beforeAll(async () => {
    kernel = (await import(kernelEntry)) as Kernel;
  });
  /** The host's side: every module as registered, through the kernel's own steps. */
  const divergence = (mods: typeof modules, stored: string) =>
    kernel.migrationSetDivergence(
      mods.map((m) => ({ id: m.manifest.id, steps: kernel.migrationSteps(m as never) })),
      stored,
    );

  it('every derived step the kernel generates is named as derived — the property the comparison rests on', () => {
    for (const m of modules) {
      const authored = new Set(m.migrations.map((s) => s.version));
      const derived = kernel.moduleMigrations(m as never).filter((s) => !authored.has(s.version));
      expect(derived.length, m.manifest.id).toBeGreaterThan(0);
      for (const s of derived) expect(kernel.isDerivedMigrationVersion(s.version), s.version).toBe(true);
      for (const v of authored) expect(kernel.isDerivedMigrationVersion(v), v).toBe(false);
    }
  });

  it('with the derived steps stored (a CLI that resolved the kernel), the host accepts', async () => {
    const pushedSet = flattenDeclaredMigrations(permissions(modules), kernel.moduleMigrations as never).migrations!;
    expect(pushedSet.some((m) => kernel.isDerivedMigrationVersion(m.version))).toBe(true);
    expect(await divergence(modules, await kernel.migrationSetDigest(pushedSet))).toBeNull();
  });

  it('with the derived steps absent (a CLI that did not resolve the kernel, or an older one), the host accepts', async () => {
    const authoredOnly = flattenDeclaredMigrations(permissions(modules)).digestMigrations;
    expect(authoredOnly.some((m) => kernel.isDerivedMigrationVersion(m.version))).toBe(false);
    expect(await divergence(modules, await kernel.migrationSetDigest(authoredOnly))).toBeNull();
  });

  it('a stored set that differs ONLY in derived steps cannot refuse: other SQL, a missing one, an extra one', async () => {
    const full = flattenDeclaredMigrations(permissions(modules), kernel.moduleMigrations as never).migrations!;
    const firstDerived = full.findIndex((m) => kernel.isDerivedMigrationVersion(m.version));
    const respelled = full.map((m, i) => (i === firstDerived ? { ...m, sql: `${m.sql} -- respelled` } : m));
    const missing = full.filter((_, i) => i !== firstDerived);
    const extra = [...full, { moduleId: 'states', version: 'state/ticket:purge', sql: 'CREATE INDEX x ON ticket (id);' }];
    for (const stored of [respelled, missing, extra]) {
      expect(await divergence(modules, await kernel.migrationSetDigest(stored))).toBeNull();
    }
  });

  it('the twin: an authored migration whose SQL differs from the stored one is refused', async () => {
    const pushedSet = flattenDeclaredMigrations(permissions(modules), kernel.moduleMigrations as never).migrations!;
    const deployed = modules.map((m) =>
      m.manifest.id === 'states' ? { ...m, migrations: [TABLE, { ...NEXT, sql: 'ALTER TABLE ticket ADD COLUMN other TEXT;' }] } : m,
    );
    expect(await divergence(deployed, await kernel.migrationSetDigest(pushedSet))).toMatch(
      /^the authored migrations this deployment registers are not the ones stored/,
    );
  });

  it('without a kernel, a module declaring only entityStates carries no migrations — never an authored-only set', () => {
    const r = flattenDeclaredMigrations(permissions([modules[0]!]));
    expect(r.migrations).toBeUndefined();
    expect(r.omitted).toMatch(/declares searchables, lists or entityStates/);
    expect(r.unresolvedIndexes).toEqual([{ moduleId: 'states', searchables: [], lists: [], entityStates }]);
  });
});
