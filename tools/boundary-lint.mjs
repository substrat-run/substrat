#!/usr/bin/env node
/**
 * Repo entry point for the layer rules. The implementation lives in
 * `packages/boundary-lint` and ships to strangers as
 * `@substrat-run/boundary-lint` — this monorepo lints itself with the same code
 * a from-scratch vertical runs, so the rules can never drift between what we
 * enforce on ourselves and what we enforce on the product.
 *
 * Kept as `tools/boundary-lint.mjs` because CI, CLAUDE.md, and
 * `.claude/settings.local.json` all name this path.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  lint,
  loadConfig,
  formatViolations,
} from '../packages/boundary-lint/dist/index.js';
import { syncTemplate } from './template-sync.mjs';

const root = new URL('..', import.meta.url).pathname;

let failed = false;

function report(label, violations, where) {
  if (!violations.length) return;
  failed = true;
  console.error(`boundary-lint (${label}): ${violations.length} violation(s)`);
  if (where) console.error(`  paths below are relative to ${where}`);
  console.error('');
  console.error(formatViolations(violations));
  console.error('');
}

report('workspace', lint(root, loadConfig(root)));

// The create-substrat template — module code by every rule that matters, and until
// #878 the one body of it nothing in this repo linted. It is not a workspace member
// (deliberately: #797 needs it to install from npm), so it is materialized into
// `packages/template-check` and linted there as a STANDALONE vertical — the same
// discovery path `substrat-boundary-lint` takes inside a real scaffold, which is how
// this can promise that what we enforce on ourselves is what a new project gets.
//
// This is the gate that caught `config-do.ts` missing from DEFAULT_HARNESS — after
// the release, on a user's machine, because nothing here had ever looked.
const templateRoot = syncTemplate();

// A standalone lint whose engines did not resolve passes by scanning nothing, which
// is the one way this check could go quietly useless. The scaffold declares two.
const engineDir = join(templateRoot, 'node_modules', '@substrat-run');
const engines = existsSync(engineDir)
  ? readdirSync(engineDir).filter((n) => n.startsWith('engine-'))
  : [];
if (engines.length === 0) {
  console.error(
    'boundary-lint: the template check resolved NO engines — R5 would pass by scanning\n' +
      '  nothing. Run `pnpm install`, and `pnpm -r build` so the engines have a dist.',
  );
  process.exit(2);
}

report('create-substrat template', lint(templateRoot), 'packages/create-substrat/template');

if (failed) process.exit(1);
console.log(
  `boundary-lint: all layer rules hold (workspace + the create-substrat template, ${engines.length} engines)`,
);
