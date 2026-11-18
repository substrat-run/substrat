#!/usr/bin/env node
/**
 * A workflow in this repo runs the CLI built from its own checkout, never a registry copy.
 *
 * `substrat push` gates every upload on the layer rules, and it runs them from the
 * `@substrat-run/boundary-lint` it bundles. CI's `lint:boundaries` runs them from the
 * workspace's `packages/boundary-lint`. Those are the same code only when the CLI is the
 * workspace's: `npx @substrat-run/cli@latest` judges main's code by the rules of the LAST
 * RELEASE. So a PR that changes a rule — a harness entry for a declared network boundary,
 * say — is green in CI and refused by the deploy that runs on its merge, until a release
 * catches the registry up. #3274 did exactly that: `demos/auth-server/src/social-relay-self.ts`
 * joined the harness list, `lint:boundaries` passed, and the auth-server deploy's push refused
 * it as R3. The opposite skew is worse and silent: a rule tightened on main is not applied to
 * a push from main.
 *
 * ticket0's deploy already pushed with `node packages/cli/dist/cli.js` for this reason; the
 * auth-server and meridian deploys were generated with the registry spelling and kept it.
 * This gate is what keeps a regenerated workflow (`substrat init --ci github`, or the
 * dashboard's one-click setup, which writes the registry spelling because a project outside
 * this monorepo has no CLI source) from bringing it back.
 *
 * Refused, on a line that is not a YAML comment: `npx`, `pnpm dlx`, `yarn dlx`, `bunx`,
 * `npm exec` or a global `npm install` naming `@substrat-run/cli` or
 * `@substrat-run/boundary-lint`, with or without a version. A line that genuinely wants the
 * registry copy — a check of what npm serves, like `lint:scaffold` — says so on that line or
 * the one above it: `# workspace-cli-allow: <reason>`.
 *
 * Text, not a YAML parse: a run script is a string to YAML, and the command is what is judged.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER = String.raw`(?:\bnpx|\bbunx|\b(?:pnpm|yarn)\s+dlx|\bnpm\s+exec|\bnpm\s+(?:i|install|add)\b[^\n]*?\s(?:-g|--global)\b)`;
const PACKAGE = String.raw`@substrat-run/(?:cli|boundary-lint)(?![\w-])`;
const REGISTRY_CLI = new RegExp(`${RUNNER}[^\\n#]*?${PACKAGE}`);
const ALLOW = /#\s*workspace-cli-allow:\s*\S/;

/** A line with its YAML comment removed: a `#` that starts the line or follows whitespace. */
const code = (line) => line.replace(/(^|\s)#.*$/, '$1');

/** `[{ line, text }]` for every registry CLI invocation in one workflow's source. */
export function findRegistryCli(src) {
  const lines = src.split('\n');
  const found = [];
  lines.forEach((line, i) => {
    if (!REGISTRY_CLI.test(code(line))) return;
    if (ALLOW.test(line) || (i > 0 && ALLOW.test(lines[i - 1]))) return;
    found.push({ line: i + 1, text: line.trim() });
  });
  return found;
}

function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const dir = join(root, '.github', 'workflows');
  if (!existsSync(dir)) {
    console.error('lint:workspace-cli: no .github/workflows directory');
    process.exit(2);
  }
  const offences = [];
  let read = 0;
  for (const name of readdirSync(dir).sort()) {
    if (!/\.ya?ml$/.test(name)) continue;
    read++;
    for (const f of findRegistryCli(readFileSync(join(dir, name), 'utf8'))) {
      offences.push(`  .github/workflows/${name}:${f.line}  ${f.text}`);
    }
  }
  if (offences.length > 0) {
    console.error(`lint:workspace-cli: ${offences.length} workflow line(s) run a registry @substrat-run CLI:\n`);
    console.error(offences.join('\n'));
    console.error(
      '\n  Run the checkout\'s own build instead (`node packages/cli/dist/cli.js …`, after building' +
        '\n  `@substrat-run/cli...`): the push gate must judge with the same layer rules as CI\'s' +
        '\n  lint:boundaries. A line that must read the registry says why with' +
        '\n  `# workspace-cli-allow: <reason>` on it or the line above.',
    );
    process.exit(1);
  }
  console.log(`lint:workspace-cli: ${read} workflow(s) run the workspace CLI only`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
