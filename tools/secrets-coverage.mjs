#!/usr/bin/env node
/**
 * `scripts/secrets.mjs` refuses a deploy when a key it KNOWS about is blank — but it had
 * no way to refuse when a worker gained a new secret it never learned about at all.
 * That is exactly how `TENANT_TOKEN_SECRET` (#1602) took the control plane down: the
 * worker declared it, read it, and documented "this must be set … BEFORE the dashboard",
 * while `scripts/secrets.mjs` never listed it in `required` or `secrets` — so `check`,
 * `status` and `push` all stayed silent about the one thing an operator needed to do.
 *
 * This is the mechanical half of not letting that happen again, in two checks:
 *
 *  1. MANIFEST self-consistency: every name in a worker's `required` array is a key in
 *     that worker's `secrets` map. A `required` entry with no mapping is not enforced by
 *     anything — `resolveForWorker` only walks `secrets` — so it would silently stop
 *     gating the moment someone typo'd or half-finished an edit.
 *  2. Source-linked coverage: a worker's own `Env` interface is read for a `string`
 *     field whose doc comment says "must be set" — the phrase `worker.ts` uses for
 *     exactly this class of secret (TENANT_TOKEN_SECRET, PLATFORM_SECRET) — and that
 *     name is asserted present in the worker's `required` array. A worker gaining a new
 *     hard-required secret without a MANIFEST entry now fails here instead of in
 *     production.
 *
 * (2) is deliberately narrow — it reads one phrase, not "every string field", because
 * most of a worker's `Env` fields are optional behavioural config that intentionally
 * lives in `wrangler.jsonc` `vars` and is never meant to reach `secrets.mjs` (see its
 * own header). A blanket "every field must be mapped" rule would refuse those by
 * construction. What it buys is real: a secret whose own doc comment declares operator
 * obligation is exactly the shape of the bug this file exists to catch.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MANIFEST } from '../scripts/secrets.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const problems = [];

// ── 1. MANIFEST self-consistency ────────────────────────────────────────────────
for (const [worker, cfg] of Object.entries(MANIFEST)) {
  for (const name of cfg.required ?? []) {
    if (!(name in cfg.secrets)) {
      problems.push(`${worker}: '${name}' is in \`required\` but has no \`secrets\` mapping — check/push never enforce it`);
    }
  }
}

// ── 2. source-linked coverage: a field whose own doc comment says "must be set" ─
const MUST_BE_SET = /must be set/i;
const FIELD = /^\s*([A-Z][A-Z0-9_]*)\??:\s*string;\s*$/;

function fieldsRequiringSetup(src) {
  const lines = src.split('\n');
  const found = [];
  let commentStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('/**')) commentStart = i;
    const m = FIELD.exec(line);
    if (m && commentStart >= 0 && MUST_BE_SET.test(lines.slice(commentStart, i).join('\n'))) {
      found.push(m[1]);
    }
    if (!line.trim().startsWith('*') && !line.trim().startsWith('/**')) commentStart = -1;
  }
  return found;
}

for (const [worker, cfg] of Object.entries(MANIFEST)) {
  const workerFile = join(ROOT, cfg.dir, 'src/worker.ts');
  let src;
  try {
    src = readFileSync(workerFile, 'utf8');
  } catch {
    continue; // no single worker.ts to read for this member — nothing to check
  }
  const required = new Set(cfg.required ?? []);
  for (const name of fieldsRequiringSetup(src)) {
    if (!required.has(name)) {
      problems.push(
        `${worker}: ${cfg.dir}/src/worker.ts declares \`${name}\` "must be set", but it is not in MANIFEST['${worker}'].required`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error('secrets-coverage: scripts/secrets.mjs is missing a secret a worker declares required.\n');
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('\nAdd the missing name to MANIFEST.<worker>.required and .secrets in scripts/secrets.mjs.');
  process.exit(1);
}
console.log('secrets-coverage: ok');
