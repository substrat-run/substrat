import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DeployManifest } from '@substrat-run/contracts';
import { assertSchedulesAreSwept, deployConfigIfAny } from '../src/push.js';
import { exportedSweeperNames, exportedSweeperNamesOf, sweeperOffence } from '../src/schedule-sweeper.js';

/**
 * Declared schedules need a sweeper to run them on a hosted deploy (#1646). This repo's
 * `lint:schedule-sweeper` holds that for the verticals in it; `substrat push` is the only check
 * an external vertical passes through, so it refuses the same shape.
 */

const SWEEPER_ENTRY = [
  "import { defineScopeSweeperDO } from '@substrat-run/adapter-cloudflare';",
  'export const SweeperDO = defineScopeSweeperDO<Env>({ host: hostFor });',
  'export default {};',
].join('\n');

/** A schedule an ENGINE declares — the case a text search of the vertical's own source misses. */
const ENGINE_SCHEDULE = [{ moduleId: '@substrat-run/engine-absence', operation: 'absence/expire-stale' }];

function tree(files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'substrat-cli-sweeper-')));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

function pkg(stores: { binding: string; class: string }[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: '@acme/leave',
    version: '1.0.0',
    substrat: { permissions: 'perms.mjs', runtimeNeeds: { entry: 'src/worker.ts', stores }, ...extra },
  });
}

const STORES = [{ binding: 'SCOPE', class: 'ScopeDO' }];
const STORES_WITH_SWEEPER = [...STORES, { binding: 'SWEEPER', class: 'SweeperDO' }];

describe('exportedSweeperNames — what workerd can bind, from one file', () => {
  it('reads `export const X = defineScopeSweeperDO(…)`', () => {
    expect(exportedSweeperNames(SWEEPER_ENTRY)).toEqual(['SweeperDO']);
  });

  it('reads `export class X extends defineScopeSweeperDO(…) {}`', () => {
    const src = "import { defineScopeSweeperDO } from 'x';\nexport class Timer extends defineScopeSweeperDO({}) {}\n";
    expect(exportedSweeperNames(src)).toEqual(['Timer']);
  });

  it('gives nothing for a call in an unexported const — it binds no class', () => {
    const src = "import { defineScopeSweeperDO } from 'x';\nconst SweeperDO = defineScopeSweeperDO({});\n";
    expect(exportedSweeperNames(src)).toEqual([]);
  });

  it('names the ALIAS of a re-exported local, because that is what a binding must name', () => {
    const src = "import { defineScopeSweeperDO as d } from 'x';\nconst Inner = d({});\nexport { Inner as SweeperDO };\n";
    expect(exportedSweeperNames(src)).toEqual(['SweeperDO']);
  });

  it('ignores an unrelated Durable Object export', () => {
    expect(exportedSweeperNames('export const ScopeDO = defineScopeDO(MODULES, {});\n')).toEqual([]);
  });
});

describe('exportedSweeperNamesOf — follows relative re-exports, so a sweeper in its own module counts', () => {
  const SWEEPER_MODULE = "import { defineScopeSweeperDO } from '@substrat-run/adapter-cloudflare';\nexport const SweeperDO = defineScopeSweeperDO({});\n";

  it('`export { X } from "./sweeper.js"` resolves to the .ts source', () => {
    const dir = tree({
      'src/worker.ts': "export { SweeperDO } from './sweeper.js';\nexport default {};\n",
      'src/sweeper.ts': SWEEPER_MODULE,
    });
    expect(exportedSweeperNamesOf(join(dir, 'src/worker.ts'))).toEqual(['SweeperDO']);
  });

  it('`export * from "./do"` carries every sweeper the module exports', () => {
    const dir = tree({ 'src/worker.ts': "export * from './do';\n", 'src/do/index.ts': SWEEPER_MODULE });
    expect(exportedSweeperNamesOf(join(dir, 'src/worker.ts'))).toEqual(['SweeperDO']);
  });

  it('`import { X } from "./sweeper"; export { X as Y }` names the alias', () => {
    const dir = tree({
      'src/worker.ts': "import { SweeperDO } from './sweeper';\nexport { SweeperDO as Timer };\n",
      'src/sweeper.ts': SWEEPER_MODULE,
    });
    expect(exportedSweeperNamesOf(join(dir, 'src/worker.ts'))).toEqual(['Timer']);
  });

  it('a .tsx entry with JSX parses, and so does a .tsx module it re-exports', () => {
    const JSX_SWEEPER = `${SWEEPER_MODULE}const page = <div>Hello</div>;\n`;
    const own = tree({ 'src/worker.tsx': JSX_SWEEPER });
    expect(exportedSweeperNamesOf(join(own, 'src/worker.tsx'))).toEqual(['SweeperDO']);
    const reexported = tree({
      'src/worker.ts': "export { SweeperDO } from './sweeper.js';\nconst n = <number>1;\n",
      'src/sweeper.tsx': JSX_SWEEPER,
    });
    expect(exportedSweeperNamesOf(join(reexported, 'src/worker.ts'))).toEqual(['SweeperDO']);
  });

  it('a re-export of a module whose sweeper is unexported gives nothing, and a cycle terminates', () => {
    const dir = tree({
      'src/worker.ts': "export * from './a';\n",
      'src/a.ts': "export * from './worker';\nimport { defineScopeSweeperDO } from 'x';\nconst S = defineScopeSweeperDO({});\n",
    });
    expect(exportedSweeperNamesOf(join(dir, 'src/worker.ts'))).toEqual([]);
  });
});

describe('assertSchedulesAreSwept', () => {
  const quiet = () => {};

  it('owes nothing when no module declares a schedule', () => {
    const dir = tree({ 'package.json': pkg(STORES), 'src/worker.ts': 'export default {};\n' });
    expect(() => assertSchedulesAreSwept(dir, deployConfigIfAny(dir)!, undefined, false, quiet)).not.toThrow();
  });

  it('refuses an engine-declared schedule with no sweeper, naming the module, the schedule and the remedy', () => {
    const dir = tree({ 'package.json': pkg(STORES), 'src/worker.ts': 'export default {};\n' });
    let message = '';
    try {
      assertSchedulesAreSwept(dir, deployConfigIfAny(dir)!, ENGINE_SCHEDULE, false, quiet);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('@substrat-run/engine-absence → absence/expire-stale');
    expect(message).toContain('defineScopeSweeperDO');
    expect(message).toContain('noteScope');
    expect(message).toContain('--allow-unswept-schedules');
  });

  it('refuses an exported sweeper no store binds — it would never be instantiated', () => {
    const dir = tree({ 'package.json': pkg(STORES), 'src/worker.ts': SWEEPER_ENTRY });
    expect(() => assertSchedulesAreSwept(dir, deployConfigIfAny(dir)!, ENGINE_SCHEDULE, false, quiet)).toThrow(
      /never instantiates/,
    );
  });

  it('passes an exported sweeper bound in runtimeNeeds.stores', () => {
    const dir = tree({ 'package.json': pkg(STORES_WITH_SWEEPER), 'src/worker.ts': SWEEPER_ENTRY });
    expect(() => assertSchedulesAreSwept(dir, deployConfigIfAny(dir)!, ENGINE_SCHEDULE, false, quiet)).not.toThrow();
  });

  it('passes an exported sweeper bound in a hand-authored wrangler.jsonc', () => {
    const dir = tree({
      'package.json': JSON.stringify({ name: '@acme/leave', substrat: { permissions: 'perms.mjs' } }),
      'wrangler.jsonc': [
        '{',
        '  "main": "src/worker.ts", // the entry',
        '  "durable_objects": { "bindings": [ { "name": "SWEEPER", "class_name": "SweeperDO" } ] }',
        '}',
      ].join('\n'),
      'src/worker.ts': SWEEPER_ENTRY,
    });
    expect(() => assertSchedulesAreSwept(dir, deployConfigIfAny(dir)!, ENGINE_SCHEDULE, false, quiet)).not.toThrow();
  });

  it('--allow-unswept-schedules pushes anyway, and says so', () => {
    const dir = tree({ 'package.json': pkg(STORES), 'src/worker.ts': 'export default {};\n' });
    const logs: string[] = [];
    expect(() =>
      assertSchedulesAreSwept(dir, deployConfigIfAny(dir)!, ENGINE_SCHEDULE, true, (m) => logs.push(m)),
    ).not.toThrow();
    expect(logs.join('\n')).toMatch(/--allow-unswept-schedules.*absence\/expire-stale/s);
  });

  it('agrees with the predicate the repo lint uses', () => {
    expect(sweeperOffence([], { exportedNames: [], boundClassNames: [] })).toBeNull();
    expect(sweeperOffence([{ moduleId: 'm', operation: 'm/op' }], { exportedNames: [], boundClassNames: [] })).toMatch(
      /m → m\/op/,
    );
  });
});

/**
 * Through the BUILT push, in a plain node child, as `push-migrations.test.ts` does: the push
 * bundles and imports the permission entry, which vitest's module runner cannot load. The
 * wrangler build is a stub `npx`, and the upload a stubbed `fetch` that prints the manifest —
 * so "refused before anything is uploaded" is a fact the test reads.
 */
describe.runIf(existsSync(fileURLToPath(new URL('../dist/push.js', import.meta.url))))(
  'push() — refused before anything is uploaded (#1646)',
  () => {
    const pushJs = fileURLToPath(new URL('../dist/push.js', import.meta.url));
    const PERMS = `export const permissions = ${JSON.stringify({
      modules: [
        {
          manifest: {
            id: '@substrat-run/engine-absence',
            permissions: [{ key: 'absence:expire', description: 'Expire stale leave' }],
            schedules: [{ operation: 'absence/expire-stale', cadence: { everyMinutes: 1440 }, permissions: ['absence:expire'] }],
          },
        },
      ],
      roles: [],
    })};\n`;
    const RUNNER = `
const [pushJs, dir] = process.argv.slice(2);
const { push } = await import(pushJs);
globalThis.fetch = async (_url, init) => {
  process.stdout.write('\\nMANIFEST ' + init.body.get('manifest') + '\\n');
  return new Response(JSON.stringify({ id: 'v', admission: 'admitted', deploymentRef: 'r', verticalSlug: 'leave' }));
};
await push({ dir, slug: 'leave', version: '1.0.0', controlPlaneUrl: 'http://cp.invalid', authHeader: {}, skipLint: true });
`;

    function run(dir: string): { status: number; stdout: string; stderr: string } {
      const scratch = mkdtempSync(join(tmpdir(), 'substrat-cli-push-'));
      writeFileSync(
        join(scratch, 'npx'),
        `#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = "--outdir" ]; then echo "export default {}" > "$2/worker.js"; fi; shift; done\n`,
        { mode: 0o755 },
      );
      writeFileSync(join(scratch, 'run.mjs'), RUNNER);
      const r = spawnSync(process.execPath, [join(scratch, 'run.mjs'), pushJs, dir], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${scratch}:${process.env.PATH ?? ''}`, GITHUB_ACTIONS: '' },
      });
      return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    }

    it('refuses a composed engine’s schedule with no sweeper, and uploads nothing', () => {
      const r = run(tree({ 'package.json': pkg(STORES), 'perms.mjs': PERMS, 'src/worker.ts': 'export default {};\n' }));
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('absence/expire-stale');
      expect(r.stdout).not.toContain('MANIFEST ');
    });

    it('its twin, with an exported and bound sweeper, uploads the schedule', () => {
      const r = run(tree({ 'package.json': pkg(STORES_WITH_SWEEPER), 'perms.mjs': PERMS, 'src/worker.ts': SWEEPER_ENTRY }));
      expect(r.status, r.stderr).toBe(0);
      const line = r.stdout.split('\n').find((l) => l.startsWith('MANIFEST '))!;
      const manifest = JSON.parse(line.slice('MANIFEST '.length)) as DeployManifest;
      expect(manifest.schedules?.map((s) => s.operation)).toEqual(['absence/expire-stale']);
    });
  },
);

/** `substrat push --check` is the whole local gate (#1205), so it makes the same refusal. */
describe.runIf(existsSync(fileURLToPath(new URL('../dist/cli.js', import.meta.url))))(
  'substrat push --check — the same schedule check, with no build and no login',
  () => {
    const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
    const PERMS = `export const permissions = ${JSON.stringify({
      modules: [
        {
          manifest: {
            id: 'leave',
            permissions: [{ key: 'leave:remind', description: 'Remind approvers' }],
            schedules: [{ operation: 'leave/remind', cadence: { everyMinutes: 60 }, permissions: ['leave:remind'] }],
          },
        },
      ],
      roles: [],
    })};\n`;

    function check(dir: string, ...args: string[]): { status: number; stdout: string; stderr: string } {
      const home = mkdtempSync(join(tmpdir(), 'substrat-cli-home-'));
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
      delete env.SUBSTRAT_CP_URL;
      delete env.SUBSTRAT_SERVICE_TOKEN;
      delete env.SUBSTRAT_TENANT;
      const r = spawnSync(process.execPath, [cli, 'push', dir, '--check', '--skip-lint', ...args], { env, encoding: 'utf8' });
      return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    }

    it('refuses schedules with no sweeper', () => {
      const r = check(tree({ 'package.json': pkg(STORES), 'perms.mjs': PERMS, 'src/worker.ts': 'export default {};\n' }));
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('leave → leave/remind');
    });

    it('passes them with one, and --allow-unswept-schedules passes the bare tree with a warning', () => {
      expect(check(tree({ 'package.json': pkg(STORES_WITH_SWEEPER), 'perms.mjs': PERMS, 'src/worker.ts': SWEEPER_ENTRY })).status).toBe(0);
      const r = check(
        tree({ 'package.json': pkg(STORES), 'perms.mjs': PERMS, 'src/worker.ts': 'export default {};\n' }),
        '--allow-unswept-schedules',
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('warning: --allow-unswept-schedules');
    });
  },
);
