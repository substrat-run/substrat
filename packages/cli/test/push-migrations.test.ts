import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DECLARED_MIGRATIONS_MAX,
  DECLARED_MIGRATIONS_SQL_BYTES_MAX,
  DEPLOY_MANIFEST_BYTES_SAFE,
  migrationsOnTop,
  type DeployManifest,
} from '@substrat-run/contracts';
import { boundManifest, flattenDeclaredMigrations } from '../src/push.js';
import { built, kernelBuilt, pushed, pushedWith, pushJs, STORES, vertical } from './push-harness.js';

// The SQL migrations a push carries (#1677), driven through the real `push()` (./push-harness.ts).

const INIT = { version: '0001-init', sql: 'CREATE TABLE ticket (id TEXT PRIMARY KEY);' };
const ADD = { version: '0002-priority', sql: "ALTER TABLE ticket ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal';" };

describe.runIf(built)('push carries each module’s SQL migrations (#1677)', () => {
  it('ships every migration with its module and SQL, in module order then each module’s own', () => {
    const m = pushed(
      vertical([
        { id: '@substrat-run/engine-workorder', migrations: [{ version: '0001', sql: 'CREATE TABLE wo (id TEXT);' }] },
        { id: 'helpdesk', migrations: [INIT, ADD] },
      ]),
    );
    expect(m.migrations).toEqual([
      { moduleId: '@substrat-run/engine-workorder', version: '0001', sql: 'CREATE TABLE wo (id TEXT);' },
      { moduleId: 'helpdesk', ...INIT },
      { moduleId: 'helpdesk', ...ADD },
    ]);
  });

  it('sends `[]` for modules that ship no SQL — absence is reserved for "not carried"', () => {
    expect(pushed(vertical([{ id: 'helpdesk' }])).migrations).toEqual([]);
  });

  it('leaves the field OFF, and still pushes, when the set is over the manifest’s cap', () => {
    const many = Array.from({ length: DECLARED_MIGRATIONS_MAX + 1 }, (_, i) => ({ version: String(i), sql: 'SELECT 1;' }));
    // `pushed` throws unless the upload happened, so reaching the assertion is the push succeeding.
    const before = pushed(vertical([{ id: 'helpdesk', migrations: many }]));
    const after = pushed(vertical([{ id: 'helpdesk', migrations: [...many, { version: 'next', sql: 'SELECT 2;' }] }]));
    expect(before.migrations).toBeUndefined();
    expect(after.migrations).toBeUndefined();
    expect(after.digests.migration).not.toBe(before.digests.migration);
  });

  it('leaves the field OFF when escaping takes the MANIFEST past what the platform stores, though the SQL is under its cap', () => {
    // Control characters escape to six bytes each in JSON: under the SQL cap, over the row.
    const sql = '\u0001'.repeat(300 * 1024);
    expect(sql.length).toBeLessThan(DECLARED_MIGRATIONS_SQL_BYTES_MAX);
    const { manifest, stderr } = pushedWith(vertical([{ id: 'helpdesk', migrations: [{ version: '0001', sql }] }]));
    expect(manifest.migrations).toBeUndefined();
    expect(stderr).toMatch(/not carried in this version's manifest \(the manifest would be \d+ bytes/);
  });

  it('moves the migration digest when a SQL migration is added', () => {
    const before = pushed(vertical([{ id: 'helpdesk', migrations: [INIT] }]));
    const after = pushed(vertical([{ id: 'helpdesk', migrations: [INIT, ADD] }]));
    expect(after.migrations).not.toEqual(before.migrations);
    expect(after.digests.migration).not.toBe(before.digests.migration);
    expect(after.digests.permission).toBe(before.digests.permission);
  });

  it('moves the migration digest when existing SQL changes under the same version', () => {
    const before = pushed(vertical([{ id: 'helpdesk', migrations: [INIT] }]));
    const after = pushed(vertical([{ id: 'helpdesk', migrations: [{ ...INIT, sql: 'CREATE TABLE ticket (id TEXT, title TEXT);' }] }]));
    expect(after.digests.migration).not.toBe(before.digests.migration);
  });

  it('moves the migration digest when only a module ID changes', () => {
    const before = pushed(vertical([{ id: 'helpdesk', migrations: [INIT] }]));
    const after = pushed(vertical([{ id: '@acme/helpdesk', migrations: [INIT] }]));
    expect(after.migrations?.[0]?.sql).toBe(before.migrations?.[0]?.sql);
    expect(after.migrations?.[0]?.version).toBe(before.migrations?.[0]?.version);
    expect(after.digests.migration).not.toBe(before.digests.migration);
  });

  it('moves the migration digest when only a version changes', () => {
    const before = pushed(vertical([{ id: 'helpdesk', migrations: [INIT] }]));
    const after = pushed(vertical([{ id: 'helpdesk', migrations: [{ ...INIT, version: '0002-init' }] }]));
    expect(after.migrations?.[0]?.sql).toBe(before.migrations?.[0]?.sql);
    expect(after.digests.migration).not.toBe(before.digests.migration);
  });

  it('moves the migration digest when migration order changes', () => {
    const before = pushed(vertical([{ id: 'helpdesk', migrations: [INIT, ADD] }]));
    const after = pushed(vertical([{ id: 'helpdesk', migrations: [ADD, INIT] }]));
    expect(after.migrations).toEqual([...before.migrations!].reverse());
    expect(after.digests.migration).not.toBe(before.digests.migration);
  });

  it('and the digest DOES move for a new Durable-Object class — the one change it covers', () => {
    const before = pushed(vertical([{ id: 'helpdesk', migrations: [INIT] }]));
    const after = pushed(vertical([{ id: 'helpdesk', migrations: [INIT] }], [...STORES, { binding: 'IDENTITY', class: 'IdentityDO' }]));
    expect(after.digests.migration).not.toBe(before.digests.migration);
  });
});

/**
 * The migrations nobody authored (#1677, a Copilot finding on #1766): a host also applies the
 * indexes a module's `searchables` and `lists` declare, derived by the kernel. The push carries
 * them through the vertical's OWN kernel's `moduleMigrations`, the function the hosts store.
 */
describe.runIf(built && kernelBuilt)('push carries the derived index migrations too', () => {
  const TABLE = { version: '0001-init', sql: 'CREATE TABLE ticket (id TEXT PRIMARY KEY, title TEXT, status TEXT, created_at TEXT);' };
  const searchables = [{ entityType: 'ticket', fields: ['title'], table: 'ticket', idColumn: 'id', tokenizer: 'unicode61' }];
  const lists = [{ entityType: 'ticket', sortable: ['created_at', 'id'], filterable: ['status'], table: 'ticket', idColumn: 'id' }];

  it('in the host’s order: authored, then the search index, then the list index', () => {
    const m = pushed(vertical([{ id: 'helpdesk', migrations: [TABLE], searchables, lists }], STORES, { kernel: true }));
    expect(m.migrations?.map((x) => x.version.split('/')[0])).toEqual(['0001-init', 'search', 'list']);
    expect(m.migrations?.[2]?.sql).toMatch(/CREATE INDEX/);
  });

  it('a push that changes ONLY `lists` shows as a migration the promote would run', () => {
    const before = pushed(vertical([{ id: 'helpdesk', migrations: [TABLE], lists }], STORES, { kernel: true }));
    const after = pushed(
      vertical([{ id: 'helpdesk', migrations: [TABLE], lists: [{ ...lists[0], filterable: ['status', 'title'] }] }], STORES, { kernel: true }),
    );
    const diff = migrationsOnTop(after.migrations!, before.migrations!);
    expect(diff.total).toBeGreaterThan(0);
    expect(diff.added.map((a) => a.version)).toEqual([expect.stringMatching(/^list\/ticket:/)]);
    expect(after.digests.migration).not.toBe(before.digests.migration);
  });

  it('and one that changes ONLY `searchables` likewise', () => {
    const before = pushed(vertical([{ id: 'helpdesk', migrations: [TABLE], searchables }], STORES, { kernel: true }));
    const after = pushed(
      vertical([{ id: 'helpdesk', migrations: [TABLE], searchables: [{ ...searchables[0], fields: ['title', 'status'] }] }], STORES, {
        kernel: true,
      }),
    );
    expect(migrationsOnTop(after.migrations!, before.migrations!).added.map((a) => a.version)).toEqual([
      expect.stringMatching(/^search\/ticket:/),
    ]);
    expect(after.digests.migration).not.toBe(before.digests.migration);
  });

  it('without a kernel to derive them, a module declaring lists carries NO migrations — never a short set', () => {
    const { manifest, stderr } = pushedWith(vertical([{ id: 'helpdesk', migrations: [TABLE], lists }]));
    expect(manifest.migrations).toBeUndefined();
    expect(stderr).toMatch(/declares searchables or lists/);
  });

  it('tracks unresolved index declarations when an older kernel cannot derive their SQL', () => {
    const before = pushed(vertical([{ id: 'helpdesk', migrations: [TABLE], lists }]));
    const after = pushed(vertical([{ id: 'helpdesk', migrations: [TABLE], lists: [{ ...lists[0], filterable: ['title'] }] }]));
    expect(before.migrations).toBeUndefined();
    expect(after.migrations).toBeUndefined();
    expect(after.digests.migration).not.toBe(before.digests.migration);
  });
});

/**
 * The deploy workflows name the vertical RELATIVELY (`substrat push demos/ticket0`). The
 * declared surface is read through an esbuild stdin entry whose import specifier is the entry
 * path, and a relative path written there is a bare specifier: `packages: 'external'` kept
 * `demos/…` as a package called `demos`, and every such push failed in 0.35.0.
 */
describe.runIf(built)('the declared surface reads from a relative dir', () => {
  const SURFACE = `
const [pushJs, dir] = process.argv.slice(2);
const { deriveDeclaredSurface } = await import(pushJs);
const s = await deriveDeclaredSurface(dir);
process.stdout.write('SURFACE ' + JSON.stringify({ permissions: s.registry.permissions.map((p) => p.key), migrations: s.migrations.migrations }) + '\\n');
`;

  function surfaceFrom(cwd: string, dir: string): { permissions: string[]; migrations: unknown } {
    const scratch = mkdtempSync(join(tmpdir(), 'substrat-cli-surface-'));
    const runner = join(scratch, 'run.mjs');
    writeFileSync(runner, SURFACE);
    const r = spawnSync(process.execPath, [runner, pushJs, dir], { cwd, encoding: 'utf8' });
    const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('SURFACE '));
    if (r.status !== 0 || !line) throw new Error(`surface not derived (${r.status}):\n${r.stdout}\n${r.stderr}`);
    return JSON.parse(line.slice('SURFACE '.length));
  }

  // Nested one level down, the shape `demos/ticket0` has: `root/verticals/helpdesk`.
  function nested(): { root: string; abs: string } {
    const abs = vertical([{ id: 'helpdesk', migrations: [INIT] }]);
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'substrat-cli-root-')));
    mkdirSync(join(root, 'verticals'));
    symlinkSync(abs, join(root, 'verticals', 'helpdesk'), 'dir');
    return { root, abs };
  }

  const expected = { permissions: ['helpdesk:read'], migrations: [{ moduleId: 'helpdesk', ...INIT }] };

  it('named relative to the working directory, as a CI job names it', () => {
    const { root } = nested();
    expect(surfaceFrom(root, 'verticals/helpdesk')).toEqual(expected);
  });

  it('and still named absolutely', () => {
    const { root, abs } = nested();
    expect(surfaceFrom(root, abs)).toEqual(expected);
  });
});

describe('flattenDeclaredMigrations', () => {
  const surface = (migrations: { version: string; sql: string }[]) => ({
    modules: [{ manifest: { id: 'helpdesk', permissions: [] }, migrations }],
    roles: [],
  });

  it('omits, with the reason, a set over the SQL byte cap', () => {
    const big = 'x'.repeat(1024 * 1024);
    const r = flattenDeclaredMigrations(surface([{ version: '1', sql: big }, { version: '2', sql: big }, { version: '3', sql: 'y' }]) as never);
    expect(r.migrations).toBeUndefined();
    expect(r.omitted).toMatch(/bytes of SQL/);
  });

  it('keeps a set exactly at the count cap', () => {
    const r = flattenDeclaredMigrations(
      surface(Array.from({ length: DECLARED_MIGRATIONS_MAX }, (_, i) => ({ version: String(i), sql: '' }))) as never,
    );
    expect(r.migrations).toHaveLength(DECLARED_MIGRATIONS_MAX);
  });
});

describe('boundManifest (#1677)', () => {
  const manifestOf = (sqlLength: number) =>
    ({
      version: '1.0.0',
      entry: 'index.js',
      compatibilityDate: '2026-07-01',
      compatibilityFlags: [],
      doClasses: [],
      bindings: [],
      tenantStores: [],
      blobStores: [],
      registry: { permissions: [], roles: [], entityGrants: [] },
      digests: { manifest: 'm', permission: 'p', migration: 'g' },
      migrations: [{ moduleId: 'helpdesk', version: '0001', sql: 'x'.repeat(sqlLength) }],
    }) as unknown as DeployManifest;
  const sizeOf = (m: DeployManifest) => Buffer.byteLength(JSON.stringify(m));
  const warnings: string[] = [];
  const warn = (w: string) => warnings.push(w);

  it('keeps a manifest at the bound, and drops only `migrations` from one a byte over', () => {
    const base = sizeOf(manifestOf(0));
    const at = manifestOf(DEPLOY_MANIFEST_BYTES_SAFE - base);
    expect(sizeOf(at)).toBe(DEPLOY_MANIFEST_BYTES_SAFE);
    expect(boundManifest(at, warn)).toBe(at);
    expect(warnings).toEqual([]);

    const over = manifestOf(DEPLOY_MANIFEST_BYTES_SAFE - base + 1);
    const sent = boundManifest(over, warn);
    expect(sent.migrations).toBeUndefined();
    expect({ ...sent, migrations: over.migrations }).toEqual(over);
    expect(warnings).toHaveLength(1);
  });
});
