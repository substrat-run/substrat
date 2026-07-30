/**
 * The playbook-sync checkpoint — drift control for the `create-substrat` template
 * playbook against its source, the canonical `substrat` skill.
 *
 * `packages/create-substrat/template/.substrat/playbook.md` is a hand-adapted,
 * customer-facing copy of `.claude/skills/substrat/SKILL.md`: same substance
 * (interview, coverage map, checkpoints, rules) but deliberately different in a few
 * places — tool-generic framing, a "reshape the reference" Step 4, an AGENTS.md
 * Step 8, and no monorepo paths. Because the two diverge ON PURPOSE, this is NOT a
 * regenerate-and-diff (that would erase the divergence). It is a staleness guard:
 * it records the version of the skill the playbook was last reconciled against and
 * fails CI when the skill moves, so a human is forced to decide what belongs in the
 * playbook and port it — the same "CI red makes the reading unskippable, the human
 * stays the approver" discipline as the permission and migration checkpoints.
 *
 *   pnpm lint:playbook            verify (read-only)   — same as --check
 *   pnpm lint:playbook --check    verify; CI runs this — exit 1 on drift
 *   pnpm lint:playbook --update   stamp the baseline to the current skill, AFTER
 *                                 you have reviewed the skill's changes and ported
 *                                 anything relevant into the playbook
 *
 * Exit codes follow boundary-lint's: 0 = in sync, 1 = drift, 2 = cannot run.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const update = process.argv.includes('--update');

const SOURCE = '.claude/skills/substrat/SKILL.md';
const TARGET = 'packages/create-substrat/template/.substrat/playbook.md';
const BASELINE = 'tools/playbook-sync.json';

/** Exit 2: the tool cannot do its job. Always names the remedy. */
function cannot(message: string): never {
  console.error(`playbook-sync: ${message}\n`);
  process.exit(2);
}

function sha256(rel: string): string {
  return createHash('sha256').update(readFileSync(join(root, rel))).digest('hex');
}

if (!existsSync(join(root, SOURCE))) {
  cannot(`source skill is missing: ${SOURCE}\n  This checkpoint has nothing to track.`);
}
if (!existsSync(join(root, TARGET))) {
  cannot(
    `template playbook is missing: ${TARGET}\n` +
      `  The thing this checkpoint guards does not exist — fix the template, not the check.`,
  );
}

const sourceSha = sha256(SOURCE);

if (update) {
  writeFileSync(
    join(root, BASELINE),
    `${JSON.stringify(
      {
        '//': [
          'Baseline for tools/playbook-sync.mts.',
          'sourceSha256 is the sha256 of the skill the template playbook was last',
          'reconciled against. After porting skill changes into the playbook, run',
          '`pnpm lint:playbook --update` to record that you did.',
        ],
        source: SOURCE,
        target: TARGET,
        sourceSha256: sourceSha,
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `playbook-sync: baseline stamped to the current ${SOURCE} (${sourceSha.slice(0, 12)}…).\n` +
      `  Make sure you actually ported the skill's changes into the playbook — this only\n` +
      `  records that you reconciled them; it does not do it for you.`,
  );
  process.exit(0);
}

if (!existsSync(join(root, BASELINE))) {
  cannot(`no baseline yet: ${BASELINE}\n  Run \`pnpm lint:playbook --update\` to create it.`);
}

let baseline: { source?: string; target?: string; sourceSha256?: string };
try {
  baseline = JSON.parse(readFileSync(join(root, BASELINE), 'utf8'));
} catch {
  cannot(`baseline is not valid JSON: ${BASELINE}\n  Delete it and run \`pnpm lint:playbook --update\`.`);
}

// A moved source/target means the paths above were changed without the baseline;
// treat it as unable-to-run rather than silently trusting a stale record.
if (baseline.source !== SOURCE || baseline.target !== TARGET) {
  cannot(
    `baseline points at different files than this tool:\n` +
      `  tool:     ${SOURCE} → ${TARGET}\n` +
      `  baseline: ${baseline.source} → ${baseline.target}\n` +
      `  Reconcile the paths, then \`pnpm lint:playbook --update\`.`,
  );
}

if (baseline.sourceSha256 === sourceSha) {
  console.log(`playbook-sync: in sync — the playbook was reconciled against the current skill.`);
  process.exit(0);
}

console.error(
  `playbook-sync: the source skill changed since the playbook was last reconciled.\n\n` +
    `  source:   ${SOURCE}\n` +
    `            now      ${sourceSha.slice(0, 12)}…\n` +
    `            baseline ${(baseline.sourceSha256 ?? '(none)').slice(0, 12)}…\n` +
    `  target:   ${TARGET}\n\n` +
    `  The playbook is a hand-adapted, customer-facing copy of the skill (tool-generic\n` +
    `  framing, a "reshape the reference" Step 4, an AGENTS.md Step 8, no monorepo paths).\n` +
    `  Review what changed in the skill, port anything that belongs into the playbook,\n` +
    `  then record it:\n\n` +
    `      pnpm lint:playbook --update\n\n` +
    `  This is a checkpoint, not an auto-merge: the two files diverge on purpose, so a\n` +
    `  human — not a script — decides what crosses over.`,
);
process.exit(1);
