/**
 * The generated project files — the configs a scaffold gets that are NOT in
 * `template/`, because they are computed rather than copied.
 *
 * Split out of `index.js` for one reason: `tools/template-sync.mjs` materializes
 * the template against the WORKSPACE (issue #878) and has to compile it under the
 * same configs a real scaffold gets. Two hand-kept copies of a tsconfig is the
 * drift class this repo has been bitten by repeatedly, so there is one copy and
 * both readers import it.
 *
 * The studio is the third reader: it serves these as part of its `template` reference, so a
 * generated project starts from the files a scaffold gets instead of writing its own.
 *
 * Dependency-free, like everything else in this package: the studio's worker bundles it.
 */

import { DEV_SERVERS } from './dev-servers.js';

// Substrat is 0.x, so these are caret ranges on the current minor — a caret on 0.x
// locks the minor, which is what makes a stale pin here a scaffold four minors behind
// rather than a scaffold that quietly upgrades.
//
// EMITTED, NOT EDITED. `pnpm lint:pins` writes this block from each package's own
// version and `--check` fails CI on drift; `version-packages` runs the write, so a
// bump and its pins land in the same PR. Hand-maintained, they went stale twice: once
// resolving nothing (`^0.3.37` after workorder moved to 0.4.x), and once resolving
// fine but freezing the template against packages nobody ships, which is worse — the
// scaffold's own tests stayed green while the surface moved underneath them.
//
// The runtime packages release together off one version line (the changesets `fixed`
// group), so one constant is right for all of them. Engines do NOT share a line —
// each versions on its own, so one pin per engine, deliberately.
const SUBSTRAT = '^0.185.0';
const ENGINE_WORKORDER = '^0.13.10';
const ENGINE_INVOICING = '^0.11.69';
const BOUNDARY_LINT = '^0.8.2';
const DEV_ISSUER = '^0.3.5';
const ATTACHMENT_EXTRACTORS = '^0.2.46';

export const TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      lib: ['ES2022'],
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      noEmit: true,
      types: ['node'],
    },
    include: ['src', 'test'],
    // The worker and its Cloudflare-only stores compile against workers-types
    // under their own config (tsconfig.worker.json) — the node config must not
    // see them. `src/routes.ts` is deliberately NOT excluded: the shared route
    // table must typecheck under both, which is what keeps it host-agnostic.
    exclude: ['src/worker.ts', 'src/config-do.ts'],
  },
  null,
  2,
)}\n`;

export const VITEST_CONFIG = `import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The 50-byte LIKE/GLOB pattern limit a Durable Object enforces (#1770) — on by
    // default, so a scaffolded project's own suite sees what production sees.
    setupFiles: ['./test/setup.ts'],
  },
});
`;

/**
 * The test runner a scaffold installs. Here rather than inline in `index.js`'s `packageJson()`
 * so `tools/template-sync.mjs` can hold it to the vitest the workspace runs the template on
 * (#2129): `packages/template-check` tests the template on the catalog's vitest, and a scaffold
 * on a different major is a project nothing on a PR has ever run.
 */
export const TEST_RUNNER = { vitest: '^5.0.0', '@vitest/ui': '^5.0.0' };

/** The package.json of a new project. */
export function packageJson(name) {
  return `${JSON.stringify(
    {
      name,
      version: '0.0.0',
      private: true,
      type: 'module',
      // What `substrat push` reads: the permission surface (the registry the
      // promotion checkpoint diffs) and the runtime needs the deploy config is
      // derived from — you never author wrangler config (src/worker.ts is the
      // entry; ScopeDO is the store it exports). Also the client-neutral home of
      // the dev topology `.claude/launch.json` is emitted from — see
      // dev-servers.js for why the port is read from the code and never declared.
      substrat: {
        permissions: 'src/provision.ts',
        runtimeNeeds: {
          entry: 'src/worker.ts',
          stores: [
            { binding: 'SCOPE', class: 'ScopeDO' },
            // The scope-local sweep singleton — the deployment's own timer (#461).
            { binding: 'SWEEPER', class: 'SweeperDO' },
            // Per-instance config delivered by the platform (/internal/configure) —
            // one DO per tenant, rows per scope. Without it the app cannot receive
            // the settings the dashboard offers its users.
            { binding: 'CONFIG', class: 'ConfigDO' },
          ],
        },
        // No envSpec copy here (#1206): the declared per-instance settings live in
        // src/manifest.ts (`SHOP_ENV`), re-exported as `envSpec` from the permissions
        // entry — `substrat push` reads them off that same import. The dashboard
        // renders its Settings form from what the push uploads.
        devServers: DEV_SERVERS,
      },
      scripts: {
        // Two processes: the local OIDC issuer you sign in at, and the API.
        dev: 'concurrently -n issuer,api -c magenta,blue "pnpm run issuer" "tsx watch src/server.ts"',
        issuer: 'substrat-dev-issuer --personas src/personas.ts',
        server: 'tsx src/server.ts',
        test: 'vitest run',
        // The live test dashboard: the `tests` entry of .claude/launch.json, opened at the
        // tokenised URL vitest prints. `--watch` is explicit, since vitest runs once and exits without a TTY.
        'test:ui': 'vitest --watch --ui --open=false -c vitest.ui.config.ts',
        typecheck: 'tsc --noEmit && tsc -p tsconfig.worker.json --noEmit',
        'lint:boundaries': 'substrat-boundary-lint',
      },
      dependencies: {
        '@substrat-run/kernel': SUBSTRAT,
        '@substrat-run/contracts': SUBSTRAT,
        '@substrat-run/adapter-sqlite': SUBSTRAT,
        '@substrat-run/adapter-cloudflare': SUBSTRAT,
        '@substrat-run/vertical-host': SUBSTRAT,
        '@substrat-run/attachment-extractors': ATTACHMENT_EXTRACTORS,
        '@substrat-run/engine-workorder': ENGINE_WORKORDER,
        '@substrat-run/engine-invoicing': ENGINE_INVOICING,
        hono: '^4.6.0',
        '@hono/node-server': '^1.13.0',
        'better-sqlite3': '^13.0.3',
      },
      devDependencies: {
        '@substrat-run/boundary-lint': BOUNDARY_LINT,
        // The local OIDC issuer `pnpm dev` signs you in at. A devDependency on
        // purpose: it is never imported by anything the worker bundles.
        '@substrat-run/dev-issuer': DEV_ISSUER,
        // What `substrat push` builds the Worker with. The CLI runs the project's own
        // wrangler and never downloads one, so a push builds with the version pinned here.
        wrangler: '^4.151.0',
        // Major 5, because wrangler 4.151+ peers on it: with 4 here, `npm install` of a new
        // project stops on ERESOLVE. The template compiles against 5 (checked by installing a
        // scaffold from npm); the workspace catalog, which template-check reads, is still on 4.
        '@cloudflare/workers-types': '^5.20261023.1',
        '@types/better-sqlite3': '^9.6.0',
        '@types/node': '^22.0.0',
        concurrently: '^9.0.0',
        tsx: '^4.19.0',
        typescript: '^5.6.0',
        ...TEST_RUNNER,
      },
      // Do NOT add `zod` here — import `z` from `@substrat-run/contracts` (AGENTS.md, rule 10).
      // better-sqlite3 >=13 ships prebuilt binaries for every supported platform and
      // declares no install script, so it needs no build allowlist entry.
    },
    null,
    2,
  )}\n`;
}
