#!/usr/bin/env node
/**
 * The committed lockfile names no builder-studio scratch project.
 *
 * `.builder/projects/*` are gitignored — each studio project is its own git repo
 * (builder-studio.md §4.6) — but they ARE pnpm workspace members, deliberately, so
 * `workspace:*` deps resolve and the per-project gates can run (pnpm-workspace.yaml says
 * why). The consequence is that every `pnpm install` run while a studio or eval project
 * exists writes it into pnpm-lock.yaml as an importer, and pnpm-lock.yaml is committed and
 * PUBLIC. The names are whatever the person building a studio project typed.
 *
 * Four of them reached main before anyone noticed (#769), and nothing downstream
 * complained: `pnpm install --frozen-lockfile` does NOT fail on a lockfile importer whose
 * directory is absent from the checkout, so CI installed cleanly and stayed green. That is
 * the hole. A leak nobody can see is a leak that stays.
 *
 * ## Why this exists when .githooks/pre-commit already refuses the same thing
 *
 * The hook is the local half and it stays. It is also, by construction, skippable in three
 * ways this check is not:
 *
 *   - `git commit --no-verify` bypasses it, which is a feature;
 *   - it is wired by the root `prepare` script, so a checkout that has never run
 *     `pnpm install` — or one whose `core.hooksPath` points elsewhere — does not have it at
 *     all, and `prepare` deliberately no-ops under CI;
 *   - it reads the STAGED DIFF, so it judges what a commit adds. A commit that removes one
 *     scratch importer and leaves a second behind adds nothing and passes, correctly, while
 *     the one left behind is still in a public file. tools/fixtures/lockfile-scratch/
 *     removal-partial.yaml is that case.
 *
 * So this is the same rule asked of the FILE rather than of a diff, at the one boundary
 * nobody can be absent from. Between them the local hook catches it while it is still cheap
 * to fix, and this one makes it impossible to merge.
 *
 * ## It reads the working tree, like every other refusing gate here
 *
 * In CI the checkout IS the committed state, which is the whole point. In a local checkout
 * it reads whatever pnpm-lock.yaml currently says, so a developer with a studio project
 * open sees this go red before they have committed anything. That is expected and is not
 * yet a problem — local churn is fine right up until it is committed — and the failure
 * message says so.
 *
 * Text, not a YAML parser: the file is machine-written, the rule is about one path prefix,
 * and pulling in a parser to read a key would buy nothing. What a text rule owes in return
 * is the guard below — it refuses a lockfile it could not read rather than reporting ok
 * over nothing.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The one path prefix that must never appear in a committed lockfile. */
const SCRATCH = '.builder/projects/';
const DEFAULT_LOCKFILE = 'pnpm-lock.yaml';
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'lockfile-scratch');

/** A YAML key may be quoted, and the same key means the same thing either way. */
const unquote = (key) => (/^(['"]).*\1$/.test(key) ? key.slice(1, -1) : key);

/**
 * One line with its comment removed — the only definition of "comment" this check has, used
 * by both passes below so they cannot disagree about what a line says.
 *
 * In YAML a `#` opens a comment when it starts the line or follows whitespace, and is an
 * ordinary character inside a quoted scalar. Both halves matter here and in opposite
 * directions. Stripping only FULL-line comments — which is what the first cut did — left
 * `packages/foo: {} # see .builder/projects/local` reported as an offence, naming
 * `packages/foo`, an importer that has done nothing wrong, as the offender. Stripping at
 * every `#` instead would lose the rest of a quoted value, and a git specifier carries its
 * fragment there (`'git+ssh://host/repo#…'`) — a path hidden behind one is a declaration,
 * not a note about it.
 */
const withoutComment = (line) => {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote !== null) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
};

/**
 * A lockfile read as `{ importers, offences }`, or as a reason it could not be read.
 *
 * `importers` are the top-level keys of the `importers:` section — one per workspace member
 * pnpm resolved. `offences` is every place the scratch prefix appears, whether as one of
 * those keys or anywhere else in the file: a committed member depending on a studio project
 * writes the path in as a `link:` version instead, and the name is just as public there.
 *
 * Comments are not read, by either pass — see `withoutComment`. A lockfile is machine-written
 * and carries none, a comment is not a declaration either way, and the fixtures beside this
 * file describe the offence in their own headers, so a sweep that read comments would be
 * judging its own documentation.
 */
const judge = (src) => {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => /^importers:[^\S\n]*$/.test(l));
  if (start === -1) {
    return { unreadable: 'no `importers:` section — this is not a pnpm workspace lockfile, or pnpm has renamed it' };
  }

  const importers = [];
  const keyLines = new Map(); // line index → the importer key declared on it
  let indent = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = withoutComment(lines[i]);
    if (line.trim() === '') continue; // blank, or a line that was nothing but a comment
    const lead = line.length - line.trimStart().length;
    if (lead === 0) break; // back to a top-level key: the section is over
    if (indent === null) indent = lead; // the section's own entry indentation, whatever it is
    if (lead > indent) continue; // a field of the importer above
    if (lead < indent) {
      return {
        unreadable:
          `line ${i + 1} sits inside \`importers:\` at a shallower indent than its entries — ` +
          'this check cannot tell which keys are importers, so it refuses rather than guesses',
      };
    }
    // `key:` with its fields on the lines below, or `key: {}` — which is how pnpm writes an
    // importer with no dependencies at all, and is in the real lockfile today
    // (`packages/create-substrat`). Requiring the colon to END the line skipped those keys,
    // and a scratch project with nothing installed in it is exactly that shape.
    const m = /^(.*?):(?:[^\S\n].*)?$/.exec(line.trim());
    if (m === null) continue;
    const key = unquote(m[1]);
    importers.push(key);
    keyLines.set(i, key);
  }

  const offences = [];
  for (const [i, raw] of lines.entries()) {
    const line = withoutComment(raw);
    if (!line.includes(SCRATCH)) continue;
    const key = keyLines.get(i);
    offences.push(key !== undefined ? `line ${i + 1}: importer \`${key}\`` : `line ${i + 1}: ${line.trim()}`);
  }
  return { importers, offences };
};

/**
 * The verdict as one value — a count of offences, or `'unreadable'`.
 *
 * The self-check below and the run at the end both go through this, so the two cannot come
 * to different conclusions about the same file. An offence is reported even when the section
 * came back empty: "I could not read this" is the right answer only when there is nothing
 * to say, and a scratch path in the file is something to say.
 */
const outcome = (v) => {
  if (v.unreadable !== undefined) return 'unreadable';
  if (v.offences.length > 0) return v.offences.length;
  return v.importers.length === 0 ? 'unreadable' : 0;
};

/**
 * The predicate, judged against every shape it exists to tell apart, on every run and before
 * the real lockfile is read — the same guard `lint:vite-proxy` and `lint:module-inputs`
 * carry, for the same reason: a text rule drifts silently when a regex is tidied, and a
 * check that has stopped checking is green.
 *
 * The fixtures are lockfiles rather than inline strings because that is what this reads, and
 * because the two that matter most are a PAIR — the same clean-up commit seen half done and
 * finished. Each fixture's header says what it is for; the number here is the contract.
 */
const SELF_CHECK = [
  ['clean.yaml', 0],
  ['scratch-importer.yaml', 2],
  ['scratch-quoted.yaml', 1],
  ['scratch-referenced.yaml', 1],
  ['scratch-inline-empty.yaml', 1],
  // A comment naming a scratch project is a note about one, inline or on its own line…
  ['inline-comment.yaml', 0],
  // …and a `#` that opens no comment — quoted, or tight against a git ref — does not hide
  // the path behind it. Three entries, one per way `withoutComment` could be simplified.
  ['hash-not-a-comment.yaml', 3],
  // A commit that removes one scratch importer and leaves the other is still an offence…
  ['removal-partial.yaml', 1],
  // …and the commit that finishes the job passes, deletions and all.
  ['removal-complete.yaml', 0],
  // Refused, not passed: there is nothing here to judge.
  ['no-importers.yaml', 'unreadable'],
  ['empty-importers.yaml', 'unreadable'],
];

const drift = [];
for (const [name, want] of SELF_CHECK) {
  const path = join(FIXTURES, name);
  if (!existsSync(path)) {
    drift.push(`${name}: fixture missing — the case it holds is no longer checked`);
    continue;
  }
  const got = outcome(judge(readFileSync(path, 'utf8')));
  if (got !== want) drift.push(`${name}: expected ${want}, got ${got}`);
}
if (drift.length > 0) {
  console.error('lockfile-scratch: the rule no longer tells its own cases apart — fix it before trusting a run:');
  for (const d of drift) console.error(`  ${d}`);
  process.exit(2);
}

// The importer COUNT is held too, and it is the guard that earns its keep: the whole-file
// sweep alone would pass every fixture above while the section parse read nothing, and the
// first cut of this check did silently skip every `key: {}` importer — one of which is in
// the real lockfile. What the section parse is FOR is telling an importer key from a line
// that merely mentions one, so both halves are asserted: the count, and the label.
const clean = judge(readFileSync(join(FIXTURES, 'clean.yaml'), 'utf8'));
if (clean.importers.length !== 5) {
  console.error(`lockfile-scratch: read ${clean.importers.length} of 5 importers in clean.yaml — the section scan stops early.`);
  process.exit(2);
}
// …and two fixtures are held to their offence TEXT, not only to their count. Both are key
// spellings the section parse gets wrong on its own while the whole-file sweep still goes
// red — so the file is correctly refused, the count is unchanged, and nothing would notice
// that this check had stopped being able to recognise an importer. That is how the `key: {}`
// miss survived its first run.
const LABELLED = [
  ['scratch-inline-empty.yaml', 'importer `.builder/projects/eval-fixline`'],
  ['scratch-quoted.yaml', 'importer `.builder/projects/spike`'],
];
for (const [name, want] of LABELLED) {
  const got = judge(readFileSync(join(FIXTURES, name), 'utf8')).offences[0] ?? 'nothing';
  if (!got.includes(want)) {
    console.error(`lockfile-scratch: ${name} is no longer read as an importer — wanted "${want}", got "${got}".`);
    process.exit(2);
  }
}

const lockfile = process.argv[2] ?? DEFAULT_LOCKFILE;
if (!existsSync(lockfile)) {
  console.error(`lockfile-scratch: ${lockfile} does not exist — run this from the repository root.`);
  process.exit(2);
}

const verdict = judge(readFileSync(lockfile, 'utf8'));
if (outcome(verdict) === 'unreadable') {
  const why =
    verdict.unreadable ??
    'its `importers:` section is empty, and a workspace lockfile always has at least the root importer — ' +
      'the check would pass by scanning nothing';
  console.error(`lockfile-scratch: cannot read ${lockfile} — ${why}.`);
  process.exit(2);
}

if (verdict.offences.length > 0) {
  console.error(`lockfile-scratch: ${lockfile} names builder-studio scratch projects (#769).`);
  console.error('  These are gitignored local projects; the lockfile is committed and PUBLIC, and their');
  console.error('  names are whatever a studio project was called. `--frozen-lockfile` never complains');
  console.error('  about an importer whose directory is absent, so nothing else here would notice.');
  for (const o of verdict.offences) console.error(`  ${o}`);
  console.error('');
  console.error('  Drop the `.builder/projects/*` blocks from the lockfile — by hand is fine, they are');
  console.error('  self-contained — or remove the scratch projects and re-run `pnpm install`.');
  console.error('  Locally this reads the WORKING TREE: churn from a studio project you have open is');
  console.error('  expected and is only a problem once it is committed.');
  process.exit(1);
}
console.log(`lockfile-scratch: ok (${verdict.importers.length} importers in ${lockfile}, no scratch projects)`);
