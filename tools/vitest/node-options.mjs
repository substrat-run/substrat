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
import { readdirSync } from 'node:fs';
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write(nodeOptions());
}
