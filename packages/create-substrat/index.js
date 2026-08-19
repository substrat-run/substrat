#!/usr/bin/env node
/**
 * `npm create substrat <dir>` — scaffold a Substrat vertical.
 *
 * Copies the instruction layer (AGENTS.md, the playbook, and the per-tool command
 * stubs for Claude Code / Cursor / opencode) into a new project, then generates the
 * tooling configs that need the project name interpolated. The result is a project
 * that installs and whose AI tools already know the rules and the build flow — the
 * agent writes the vertical itself, guided by `.substrat/playbook.md`.
 *
 * Dependency-free and buildless on purpose — node built-ins only, so it can never
 * break at install time and damage the name it exists to protect.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEV_SERVERS } from './dev-servers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(HERE, 'template');

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
const SUBSTRAT = '^0.77.0';
const ENGINE_WORKORDER = '^0.6.4';
const ENGINE_INVOICING = '^0.7.4';
const BOUNDARY_LINT = '^0.0.7';

const DOCS = 'https://substrat.net';

function fail(message) {
  process.stderr.write(`\n  create-substrat: ${message}\n\n`);
  process.exit(1);
}

function usage() {
  process.stdout.write(
    [
      '',
      '  Scaffold a Substrat vertical.',
      '',
      '    npm create substrat <dir>',
      '    npm create substrat .        # scaffold into the current directory',
      '',
      `  Docs: ${DOCS}`,
      '',
      '',
    ].join('\n'),
  );
}

/** npm names: lowercase, url-safe, no leading dot/underscore. */
function toPackageName(dir) {
  const name = basename(resolve(dir))
    .toLowerCase()
    .replace(/[^a-z0-9-~]+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '');
  return name || 'substrat-vertical';
}

function packageJson(name) {
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
          ],
        },
        devServers: DEV_SERVERS,
      },
      scripts: {
        dev: 'tsx watch src/server.ts',
        server: 'tsx src/server.ts',
        test: 'vitest run',
        typecheck: 'tsc --noEmit && tsc -p tsconfig.worker.json --noEmit',
        'lint:boundaries': 'substrat-boundary-lint',
      },
      dependencies: {
        '@substrat-run/kernel': SUBSTRAT,
        '@substrat-run/contracts': SUBSTRAT,
        '@substrat-run/adapter-sqlite': SUBSTRAT,
        '@substrat-run/adapter-cloudflare': SUBSTRAT,
        '@substrat-run/vertical-host': SUBSTRAT,
        '@substrat-run/engine-workorder': ENGINE_WORKORDER,
        '@substrat-run/engine-invoicing': ENGINE_INVOICING,
        hono: '^4.6.0',
        '@hono/node-server': '^1.13.0',
        'better-sqlite3': '^13.0.3',
      },
      devDependencies: {
        '@substrat-run/boundary-lint': BOUNDARY_LINT,
        '@cloudflare/workers-types': '^4.20250109.0',
        '@types/better-sqlite3': '^9.6.0',
        '@types/node': '^22.0.0',
        concurrently: '^9.0.0',
        tsx: '^4.19.0',
        typescript: '^5.6.0',
        vitest: '^3.0.0',
      },
      // Do NOT add `zod` here — import `z` from `@substrat-run/contracts` (AGENTS.md, rule 10).
      // better-sqlite3 >=13 ships prebuilt binaries for every supported platform and
      // declares no install script, so it needs no build allowlist entry.
    },
    null,
    2,
  )}\n`;
}

const TSCONFIG = `${JSON.stringify(
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
    // The worker compiles against workers-types under its own config
    // (tsconfig.worker.json) — the node config must not see it.
    exclude: ['src/worker.ts'],
  },
  null,
  2,
)}\n`;

const VITEST_CONFIG = `import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
`;

const GITIGNORE = `node_modules/
dist/
*.sqlite
*.sqlite-*
*.db
.data/
.DS_Store

# Which kernel version this checkout last announced to an agent (.substrat/hooks
# /session-start.mjs). Per-checkout state, not a project fact.
.substrat/.docs-pin
# Opt out of that hook entirely by creating this file.
.substrat/no-session-context
`;

function readme(name) {
  return `# ${name}

A multi-tenant business app built on [Substrat](${DOCS}).

\`src/\` ships with a small **working reference vertical** (a bike-repair shop, green via
\`npm test\`) — your worked example and starting point. The build flow reshapes it into your
own domain; it is not meant to survive as-is.

## Build it

Open this project in Claude Code, Cursor, or opencode and start the build flow:

- **Claude Code**: \`/substrat\`
- **Cursor / opencode**: run the \`new-vertical\` command

Both follow [\`.substrat/playbook.md\`](.substrat/playbook.md). The always-on rules the
agent must not violate live in [\`AGENTS.md\`](AGENTS.md).

## Gates

\`\`\`sh
pnpm install
pnpm test                 # the scenario, including the denials
pnpm lint:boundaries      # the layer rules (also: npx @substrat-run/boundary-lint)
pnpm typecheck
\`\`\`
`;
}

function main() {
  const target = process.argv[2];
  if (target === '-h' || target === '--help') {
    usage();
    process.exit(0);
  }
  if (!target) {
    usage();
    fail('a target directory is required — e.g. `npm create substrat my-app` (or `.` for here).');
  }

  const dest = resolve(target);
  if (existsSync(dest) && readdirSync(dest).some((f) => f === 'package.json')) {
    fail(`${target} already looks like a project (package.json present). Refusing to overwrite.`);
  }
  if (!existsSync(TEMPLATE)) {
    fail('template payload is missing from the package — please report this.');
  }

  mkdirSync(dest, { recursive: true });

  // The static instruction layer: AGENTS.md, CLAUDE.md, .substrat/, and the per-tool stubs.
  cpSync(TEMPLATE, dest, { recursive: true });

  // Generated configs — these need the project name, so they aren't in the template.
  const name = toPackageName(target);
  writeFileSync(join(dest, 'package.json'), packageJson(name));
  writeFileSync(join(dest, 'tsconfig.json'), TSCONFIG);
  writeFileSync(join(dest, 'vitest.config.ts'), VITEST_CONFIG);
  writeFileSync(join(dest, '.gitignore'), GITIGNORE);
  writeFileSync(join(dest, 'README.md'), readme(name));

  const where = target === '.' ? '' : `  cd ${target}\n`;
  process.stdout.write(
    [
      '',
      `  Scaffolded ${name}.`,
      '',
      '  The instruction layer is in place — Claude Code, Cursor, and opencode all',
      '  read the same rules (AGENTS.md) and build flow (.substrat/playbook.md).',
      '',
      '  Next:',
      where + '  pnpm install',
      '  Then open the project in your AI editor and start the build flow:',
      '    Claude Code:      /substrat',
      '    Cursor / opencode: the new-vertical command',
      '',
      '',
    ].join('\n'),
  );
}

main();
