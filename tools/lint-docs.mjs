#!/usr/bin/env node
/**
 * The two docs checkpoints behind one command (#957).
 *
 * `lint:docs` used to be `node tools/docs-drift.mjs && node tools/docs-structure.mjs`.
 * pnpm appends forwarded arguments to the END of the whole script string, so
 * `pnpm lint:docs --check` ran docs-drift with no flag at all — the advisory
 * branch, exit 0 regardless — and only docs-structure ever saw `--check`. The
 * "a published package with no reference page is a hard failure" guarantee in
 * docs-drift's own header was therefore not enforced by CI; it happened to pass.
 *
 * This runs both, forwarding every argument to each, and stops at the first
 * non-zero exit with that exit code. Run one alone with `lint:docs:drift` or
 * `lint:docs:structure`.
 *
 *   pnpm lint:docs            # both, advisory
 *   pnpm lint:docs --check    # both, CI exit codes
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

for (const script of ['tools/docs-drift.mjs', 'tools/docs-structure.mjs']) {
  const { status, error } = spawnSync(process.execPath, [join(ROOT, script), ...args], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (error) throw error;
  if (status !== 0) process.exit(status ?? 1);
}
