import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DECLARED_MIGRATIONS_MAX, type DeployManifest } from '@substrat-run/contracts';
import { flattenDeclaredMigrations } from '../src/push.js';

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

/** `migrations` per module, as a `ModuleRegistration` carries them. */
type ModuleSpec = { id: string; migrations?: { version: string; sql: string }[] };

const STORES = [{ binding: 'SCOPE', class: 'ScopeDO' }];

function vertical(modules: ModuleSpec[], stores: { binding: string; class: string }[] = STORES): string {
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
    manifest: { id: m.id, permissions: [{ key: `${m.id.split('/').pop()}:read`, description: 'Read' }] },
    ...(m.migrations ? { migrations: m.migrations } : {}),
  }));
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
  return JSON.parse(line.slice('MANIFEST '.length)) as DeployManifest;
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
