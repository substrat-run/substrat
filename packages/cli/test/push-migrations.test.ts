import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DECLARED_MIGRATIONS_MAX,
  DECLARED_MIGRATIONS_SQL_BYTES_MAX,
  DEPLOY_MANIFEST_BYTES_SAFE,
  migrationsOnTop,
  type DeployManifest,
} from '@substrat-run/contracts';
import { boundManifest, flattenDeclaredMigrations } from '../src/push.js';

/**
 * The SQL migrations a push carries (#1677), driven through the real `push()` — the only
 * place the manifest, and the digests the promotion gate compares, are assembled.
 *
 * The BUILT push, in a plain node child: the push imports a module it bundles on the fly,
 * which vitest's module runner cannot load (the `--check` suite in push.test.ts runs the
 * built CLI for the same reason). The wrangler build is a stub `npx` that writes one module
 * where wrangler would, and the upload is a stubbed `fetch` that prints the manifest part.
 * Everything between those two is the push as it ships.
 */
const pushJs = fileURLToPath(new URL('../dist/push.js', import.meta.url));
const built = existsSync(pushJs);

/** `migrations` per module, as a `ModuleRegistration` carries them; `searchables` and `lists`
 *  as its manifest declares them (#1677: the host derives index migrations from those). */
type ModuleSpec = {
  id: string;
  migrations?: { version: string; sql: string }[];
  searchables?: unknown[];
  lists?: unknown[];
};

/** The workspace kernel, linked into a fixture the way a vertical's node_modules has it. */
const workspaceKernel = fileURLToPath(new URL('../../kernel', import.meta.url));
const kernelBuilt = existsSync(join(workspaceKernel, 'dist', 'index.js'));

const STORES = [{ binding: 'SCOPE', class: 'ScopeDO' }];

function vertical(
  modules: ModuleSpec[],
  stores: { binding: string; class: string }[] = STORES,
  opts: { kernel?: boolean } = {},
): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'substrat-cli-migrations-')));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: '@acme/helpdesk',
      version: '1.0.0',
      substrat: { permissions: 'perms.mjs', runtimeNeeds: { entry: 'src/worker.ts', stores } },
    }),
  );
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'worker.ts'), 'export default {};\n');
  const entries = modules.map((m) => ({
    manifest: {
      id: m.id,
      permissions: [{ key: `${m.id.split('/').pop()}:read`, description: 'Read' }],
      ...(m.searchables ? { searchables: m.searchables } : {}),
      ...(m.lists ? { lists: m.lists } : {}),
    },
    ...(m.migrations ? { migrations: m.migrations } : {}),
  }));
  if (opts.kernel) {
    mkdirSync(join(dir, 'node_modules', '@substrat-run'), { recursive: true });
    symlinkSync(workspaceKernel, join(dir, 'node_modules', '@substrat-run', 'kernel'), 'dir');
  }
  writeFileSync(join(dir, 'perms.mjs'), `export const permissions = ${JSON.stringify({ modules: entries, roles: [] })};\n`);
  return dir;
}

const RUNNER = `
const [pushJs, dir] = process.argv.slice(2);
const { push } = await import(pushJs);
globalThis.fetch = async (_url, init) => {
  process.stdout.write('\\nMANIFEST ' + init.body.get('manifest') + '\\n');
  return new Response(JSON.stringify({ id: 'v', admission: 'admitted', deploymentRef: 'r', verticalSlug: 'helpdesk' }));
};
await push({ dir, slug: 'helpdesk', version: '1.0.0', controlPlaneUrl: 'http://cp.invalid', authHeader: {}, skipLint: true });
`;

function pushed(dir: string): DeployManifest {
  return pushedWith(dir).manifest;
}

function pushedWith(dir: string): { manifest: DeployManifest; stderr: string } {
  const scratch = mkdtempSync(join(tmpdir(), 'substrat-cli-push-'));
  // An `npx` that "builds" by writing the entry module into wrangler's --outdir.
  writeFileSync(
    join(scratch, 'npx'),
    '#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = "--outdir" ]; then echo "export default {}" > "$2/worker.js"; fi; shift; done\n',
    { mode: 0o755 },
  );
  const runner = join(scratch, 'run.mjs');
  writeFileSync(runner, RUNNER);
  const r = spawnSync(process.execPath, [runner, pushJs, dir], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${scratch}:${process.env.PATH ?? ''}`, GITHUB_ACTIONS: '' },
  });
  const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('MANIFEST '));
  if (r.status !== 0 || !line) throw new Error(`push did not upload (${r.status}):\n${r.stdout}\n${r.stderr}`);
  return { manifest: JSON.parse(line.slice('MANIFEST '.length)) as DeployManifest, stderr: r.stderr ?? '' };
}

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
    expect(pushed(vertical([{ id: 'helpdesk', migrations: many }])).migrations).toBeUndefined();
  });

  it('leaves the field OFF when escaping takes the MANIFEST past what the platform stores, though the SQL is under its cap', () => {
    // Control characters escape to six bytes each in JSON: under the SQL cap, over the row.
    const sql = '\u0001'.repeat(300 * 1024);
    expect(sql.length).toBeLessThan(DECLARED_MIGRATIONS_SQL_BYTES_MAX);
    const { manifest, stderr } = pushedWith(vertical([{ id: 'helpdesk', migrations: [{ version: '0001', sql }] }]));
    expect(manifest.migrations).toBeUndefined();
    expect(stderr).toMatch(/not carried in this version's manifest \(the manifest would be \d+ bytes/);
  });

  /**
   * The finding this issue surfaced, pinned as it stands: `digests.migration` is a hash of
   * the Durable-Object classes, not of the SQL. A push whose ONLY change is a new SQL
   * migration moves no digest, so the promotion gate's migration acknowledgement never
   * fires for it. The dialog shows the migrations either way; whether the digest should
   * cover them is a gate change and a separate decision.
   */
  it('TODAY: a push whose only change is a new SQL migration leaves every digest where it was', () => {
    const before = pushed(vertical([{ id: 'helpdesk', migrations: [INIT] }]));
    const after = pushed(vertical([{ id: 'helpdesk', migrations: [INIT, ADD] }]));
    expect(after.migrations).not.toEqual(before.migrations);
    expect(after.digests.migration).toBe(before.digests.migration);
    expect(after.digests.permission).toBe(before.digests.permission);
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
  });

  it('without a kernel to derive them, a module declaring lists carries NO migrations — never a short set', () => {
    const { manifest, stderr } = pushedWith(vertical([{ id: 'helpdesk', migrations: [TABLE], lists }]));
    expect(manifest.migrations).toBeUndefined();
    expect(stderr).toMatch(/declares searchables or lists/);
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
