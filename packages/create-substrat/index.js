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

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TSCONFIG, VITEST_CONFIG, packageJson } from './project-files.js';
import { offerLongPaths } from './windows.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(HERE, 'template');

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
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '');
  return name || 'substrat-vertical';
}

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

async function main() {
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
  // The gate key is the project's registry slug (the package name): a vertical may declare only
  // its own slug and the engines' keys (#2388), so the template's `bikeshop` becomes the name.
  for (const file of ['src/manifest.ts', 'src/provision.ts']) {
    const path = join(dest, file);
    writeFileSync(path, readFileSync(path, 'utf8').replace(/(entitlementKey: |ENTITLEMENT_KEYS = \[[^\]]*)'bikeshop'/, `$1'${name}'`));
  }
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

  // Windows only, and only when the setting is off: one question, then Windows' own prompt.
  const longPaths = await offerLongPaths();
  if (longPaths.length) process.stdout.write(`${longPaths.join('\n')}\n`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
