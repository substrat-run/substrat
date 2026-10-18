#!/usr/bin/env node
/**
 * The NODE_OPTIONS a node suite runs under in CI, from the one list there is: every `*.cjs` preload
 * in this directory (#2387). Run it to test one package the way CI does:
 *
 *   NODE_OPTIONS="$(node tools/vitest/node-options.mjs)" pnpm --filter … test
 *
 * Written so a command quoted in a doc cannot fall a preload behind: `preloads.test.mjs` holds this
 * output, the root `test` script, CI's test step and `pnpm test:affected` to the same directory.
 */
import { readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Every preload, sorted: each CommonJS file in this directory. */
export function preloadFiles() {
  return readdirSync(here).filter((f) => f.endsWith('.cjs')).sort();
}

/** `--require=<abs path>` for each preload, space-separated. */
export function nodeOptions() {
  return preloadFiles()
    .map((f) => `--require=${join(here, f)}`)
    .join(' ');
}

/**
 * Run as a script, not imported. `import.meta.url` is already the real path, while `argv[1]` is
 * the path the caller typed, so it is resolved too: compared as typed, a run through a symlink
 * printed nothing and exited 0, and `NODE_OPTIONS=""` is every preload switched off (#2399).
 */
function runAsScript() {
  const typed = process.argv[1];
  if (!typed) return false;
  try {
    return realpathSync(typed) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (runAsScript()) {
  const options = nodeOptions();
  // Never an empty answer: an empty NODE_OPTIONS reads as success and runs with no preload at all.
  if (options === '') {
    process.stderr.write(`node-options: no *.cjs preload found in ${here}\n`);
    process.exit(1);
  }
  process.stdout.write(options);
}
