/**
 * The journal — derived, appended to, never rewritten.
 *
 * Nobody writes the version number: `planMigration` reconstructs what the
 * journal has already applied, diffs it against the model, and appends exactly
 * one entry when they differ. Run it after any change to `spec/model.ts`:
 *
 *     pnpm --filter @substrat-run/demo-todo emit:migrations
 *     pnpm --filter @substrat-run/demo-todo emit:migrations --check
 *
 * `--check` is the CI half: it fails when the journal is behind the model, so a
 * schema change cannot merge without its migration appearing in the diff.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseJournal, planMigration, type Journal } from '@substrat-run/model-emit';
import { todoEntities } from '../spec/model.js';

const check = process.argv.includes('--check');
const journalPath = new URL('../journal.json', import.meta.url);
const modulePath = new URL('../src/migrations.ts', import.meta.url);

const journal: Journal = existsSync(journalPath)
  ? parseJournal(JSON.parse(readFileSync(journalPath, 'utf8')))
  : { entries: [] };

const plan = planMigration(todoEntities, journal);

if (plan.kind === 'refused') {
  process.stderr.write('emit-migrations: refused — this is a decision, not a diff\n\n');
  for (const r of plan.reasons) process.stderr.write(`  • ${r}\n\n`);
  process.exit(2);
}

if (plan.kind === 'up-to-date') {
  process.stdout.write(`journal up to date — ${journal.entries.length} entr(ies)\n`);
  process.exit(0);
}

if (check) {
  process.stderr.write(
    `emit-migrations: the journal is behind the model — ${plan.entry.slug} is unapplied.\n` +
      '  Run `pnpm --filter @substrat-run/demo-todo emit:migrations` and commit the result,\n' +
      '  so the migration appears in the pull request rather than in a console nobody opens.\n',
  );
  process.exit(1);
}

const next: Journal = { entries: [...journal.entries, plan.entry] };
writeFileSync(journalPath, `${JSON.stringify(next, null, 2)}\n`);

// The runtime shape the kernel registers, rendered from the same journal.
const module = `/**
 * GENERATED from journal.json — do not edit.
 *
 * The journal is the record; this is the shape the kernel registers. Append a
 * migration by changing spec/model.ts and re-running:
 *
 *     pnpm --filter @substrat-run/demo-todo emit:migrations
 */
import type { SqlMigration } from '@substrat-run/kernel';

export const todoMigrations: SqlMigration[] = [
${next.entries
  .map(
    (e) => `  {
    // ${e.slug}
    version: '${e.version}',
    sql: \`
${e.sql
  .split('\n')
  .map((l) => (l ? `      ${l}` : l))
  .join('\n')}
    \`,
  },`,
  )
  .join('\n')}
];
`;
writeFileSync(modulePath, module);
process.stdout.write(`appended ${plan.entry.version}-${plan.entry.slug}\n`);
