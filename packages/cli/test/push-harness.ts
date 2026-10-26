import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installFakeWrangler } from './fake-wrangler.js';
import type { DeployManifest } from '@substrat-run/contracts';

/**
 * A vertical pushed through the real `push()` — the only place the deploy manifest, and the
 * digests the promotion gate compares, are assembled (#1677, #1995).
 *
 * The BUILT push, in a plain node child: the push imports a module it bundles on the fly,
 * which vitest's module runner cannot load (the `--check` suite in push.test.ts runs the
 * built CLI for the same reason). The wrangler build is a fake `wrangler` package in the
 * vertical's node_modules (fake-wrangler.ts) that writes one module where wrangler would, and
 * the upload is a stubbed `fetch` that prints the manifest part.
 * Everything between those two is the push as it ships.
 */
export const pushJs = fileURLToPath(new URL('../dist/push.js', import.meta.url));
export const built = existsSync(pushJs);
/** What a plain-node runner passes to `import()`: a file URL works on every OS, a path does not on Windows. */
export const pushJsUrl = pathToFileURL(pushJs).href;

/** `migrations` per module, as a `ModuleRegistration` carries them; `searchables` and `lists`
 *  as its manifest declares them (#1677: the host derives index migrations from those). */
export type ModuleSpec = {
  id: string;
  reserved?: boolean;
  ownerGrants?: string[];
  migrations?: { version: string; sql: string; moves?: Record<string, string>; discards?: Record<string, string> }[];
  searchables?: unknown[];
  lists?: unknown[];
  /** As its manifest declares them (#1995: the push derives the attachment store from these). */
  attachmentTargets?: unknown[];
};

/** The workspace kernel, linked into a fixture the way a vertical's node_modules has it. */
const workspaceKernel = fileURLToPath(new URL('../../kernel', import.meta.url));
export const kernelBuilt = existsSync(join(workspaceKernel, 'dist', 'index.js'));
/** The workspace adapter-sqlite, whose `SCOPE_SPINE_DDL` the data-loss replay builds first (#2321). */
const workspaceAdapterSqlite = fileURLToPath(new URL('../../adapter-sqlite', import.meta.url));
export const adapterSqliteBuilt = existsSync(join(workspaceAdapterSqlite, 'dist', 'index.js'));

export const STORES = [{ binding: 'SCOPE', class: 'ScopeDO' }];

export function vertical(
  modules: ModuleSpec[],
  stores: { binding: string; class: string }[] = STORES,
  /** `needs`: further `runtimeNeeds` fields, beside `entry` and `stores`. */
  opts: { kernel?: boolean; adapterSqlite?: boolean; needs?: Record<string, unknown> } = {},
): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'substrat-cli-migrations-')));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: '@acme/helpdesk',
      version: '1.0.0',
      substrat: { permissions: 'perms.mjs', runtimeNeeds: { entry: 'src/worker.ts', stores, ...opts.needs } },
    }),
  );
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'worker.ts'), 'export default {};\n');
  installFakeWrangler(dir);
  const entries = modules.map((m) => ({
    manifest: {
      id: m.id,
      permissions: [{ key: `${m.id.split('/').pop()}:read`, description: 'Read', ...(m.reserved ? { holder: 'system' } : {}) }],
      ...(m.ownerGrants ? { ownerGrants: m.ownerGrants } : {}),
      ...(m.searchables ? { searchables: m.searchables } : {}),
      ...(m.lists ? { lists: m.lists } : {}),
      ...(m.attachmentTargets ? { attachmentTargets: m.attachmentTargets } : {}),
    },
    ...(m.migrations ? { migrations: m.migrations } : {}),
  }));
  if (opts.kernel) {
    mkdirSync(join(dir, 'node_modules', '@substrat-run'), { recursive: true });
    symlinkSync(workspaceKernel, join(dir, 'node_modules', '@substrat-run', 'kernel'), 'junction');
  }
  if (opts.adapterSqlite) {
    mkdirSync(join(dir, 'node_modules', '@substrat-run'), { recursive: true });
    symlinkSync(workspaceAdapterSqlite, join(dir, 'node_modules', '@substrat-run', 'adapter-sqlite'), 'junction');
  }
  writeFileSync(join(dir, 'perms.mjs'), `export const permissions = ${JSON.stringify({ modules: entries, roles: [] })};\n`);
  return dir;
}

const RUNNER = `
const [pushJs, dir, extra] = process.argv.slice(2);
const { push } = await import(pushJs);
globalThis.fetch = async (_url, init) => {
  process.stdout.write('\\nMANIFEST ' + init.body.get('manifest') + '\\n');
  return new Response(JSON.stringify({ id: 'v', admission: 'admitted', deploymentRef: 'r', verticalSlug: 'helpdesk' }));
};
const v = await push({ dir, slug: 'helpdesk', version: '1.0.0', controlPlaneUrl: 'http://cp.invalid', authHeader: {}, skipLint: true, ...JSON.parse(extra) });
process.stdout.write('\\nDATALOSS ' + JSON.stringify(v.dataLoss) + '\\n');
`;

export function pushed(dir: string): DeployManifest {
  return pushedWith(dir).manifest;
}

export function pushedWith(dir: string): { manifest: DeployManifest; stderr: string } {
  const r = pushRun(dir);
  const line = r.stdout.split('\n').find((l) => l.startsWith('MANIFEST '));
  if (r.status !== 0 || !line) throw new Error(`push did not upload (${r.status}):\n${r.stdout}\n${r.stderr}`);
  return { manifest: JSON.parse(line.slice('MANIFEST '.length)) as DeployManifest, stderr: r.stderr };
}

/** The push as a process: its exit status and both streams, uploaded or not. */
export function pushRun(
  dir: string,
  /** Further `PushOptions`, e.g. `{ requireDataLossCheck: true }`. */
  extra: Record<string, unknown> = {},
): { status: number | null; stdout: string; stderr: string } {
  const runner = join(mkdtempSync(join(tmpdir(), 'substrat-cli-push-')), 'run.mjs');
  writeFileSync(runner, RUNNER);
  const r = spawnSync(process.execPath, [runner, pushJsUrl, dir, JSON.stringify(extra)], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_ACTIONS: '' },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
