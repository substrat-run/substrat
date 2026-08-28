#!/usr/bin/env node
/**
 * The internal-docs checkpoint (docs/rfc/docs-restructure.md §8).
 *
 * `tools/docs-drift.mjs` asks whether the PUBLISHED pages have fallen behind their
 * source. This asks a different question of the INTERNAL corpus: does every document
 * still say what it is?
 *
 * The audit that produced this tool found 18 of 18 sampled documents describing shipped
 * work as unbuilt — `dashboard.md` opening "design. Not built." while `apps/dashboard`
 * had a month of commits behind it. That is not a discipline problem. Every convention in
 * this corpus is applied at authoring time by a careful author, and none of them is
 * applied at merge time by anything. This is the thing applied at merge time.
 *
 *   node tools/docs-structure.mjs            # report, and rewrite the generated index
 *   node tools/docs-structure.mjs --check    # CI: exit 1 on any violation or index drift
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { posix } from 'node:path';

const CHECK = process.argv.includes('--check');

/** The closed status vocabulary. A value outside it is a hard failure, not a warning. */
const STATUS = {
  canonical: 'a living reference, continuously updated',
  proposed: 'argued, not agreed',
  accepted: 'decided, not built',
  building: 'agreed and in flight',
  built: 'shipped; the document describes something that exists',
  superseded: 'replaced — requires superseded-by',
  historical: 'a dated record, never revised',
};

/**
 * Where a status may live. The load-bearing entry is `built`: a document that describes
 * shipped work belongs where a reader looks for shipped work, and nowhere else.
 */
const PLACEMENT = {
  built: ['architecture', 'engines'],
  canonical: ['.', 'architecture', 'strategy'],
};

/**
 * Phrases that contradict `architecture/`'s present-tense rule. Checked only in a
 * document's OPENING BLOCK — body prose may legitimately discuss a rejected proposal or
 * a future step, and banning the words outright would train people to work around the
 * gate instead of updating the document.
 */
const UNBUILT = [
  /\bnot built\b/i,
  /\bnot yet built\b/i,
  /\bbefore any code\b/i,
  /^\**Status:?\**[^\n]*\b(proposed|proposal|sketch|draft v\d)\b/im,
  /\bdesign\s*\/\s*RFC\b/i,
];

/** How many lines after the frontmatter count as the opening block. */
const OPENING_LINES = 14;

// --others --exclude-standard so a NEW, not-yet-added document is checked too;
// reading only the index would let an untracked doc pass silently until CI.
const files = execFileSync('git',
  ['ls-files', '--cached', '--others', '--exclude-standard', 'docs/**/*.md', 'docs/*.md'],
  { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean)
  .filter((f) => f !== 'docs/DECISIONS.md')          // generated
  .filter((f) => !f.startsWith('docs/decisions/'));  // owned by tools/decisions.mjs

const errs = [];
const docs = [];

for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const m = src.match(/^---\n([\s\S]*?)\n---\n+([\s\S]*)$/);
  if (!m) { errs.push(`${f}: no frontmatter`); continue; }

  const fm = Object.fromEntries(
    m[1].split('\n').filter((l) => /^[\w-]+:/.test(l)).map((l) => {
      const i = l.indexOf(':');
      return [l.slice(0, i), l.slice(i + 1).trim().replace(/^"|"$/g, '')];
    }),
  );
  const dir = posix.dirname(f).replace(/^docs\/?/, '') || '.';
  const body = m[2];
  docs.push({ file: f, dir, base: posix.basename(f), ...fm });

  if (!STATUS[fm.status]) {
    errs.push(`${f}: status "${fm.status ?? '(missing)'}" is not one of ${Object.keys(STATUS).join(', ')}`);
  }
  if (!['plan', 'kernel'].includes(fm.layer)) errs.push(`${f}: layer must be plan or kernel`);
  if (!fm.description) errs.push(`${f}: needs a one-line description (it feeds the index)`);
  if (fm.status === 'superseded' && !fm['superseded-by']) {
    errs.push(`${f}: status superseded requires superseded-by`);
  }

  const allowed = PLACEMENT[fm.status];
  if (allowed && !allowed.includes(dir) && !allowed.includes(dir.split('/')[0])) {
    errs.push(`${f}: status "${fm.status}" belongs in ${allowed.map((d) => d + '/').join(' or ')}, not ${dir}/`);
  }

  // The present-tense rule, scoped to the opening block.
  if (dir === 'architecture' || dir.startsWith('architecture/') || dir === 'engines') {
    const opening = body.split('\n').slice(0, OPENING_LINES).join('\n');
    for (const re of UNBUILT) {
      const hit = opening.match(re);
      if (hit) {
        errs.push(`${f}: opens describing itself as unbuilt ("${hit[0].trim().slice(0, 48)}") — ` +
          `${dir}/ is present tense. Rewrite it, or move it to rfc/.`);
        break;
      }
    }
  }

  // Every relative link resolves. The move in Phase 3 broke 84 of these silently.
  for (const [, href] of body.matchAll(/\]\((\.{0,2}[^):\s]*?\.md)(?:#[^)]*)?\)/g)) {
    if (!existsSync(posix.join(posix.dirname(f), href))) errs.push(`${f}: dead link -> ${href}`);
  }
}

/* ---- the generated index inside docs/README.md ---- */
const GROUPS = [
  ['.', 'Root', 'The plan, the log, this map.'],
  ['strategy', '`strategy/`', 'Why we build this, for whom, at what price. These are **satellites of the master plan**, not rivals to it: where one disagrees with the plan, the plan wins and the satellite is stale. Several are cited as normative by `architecture/` documents and open questions, so none of them is idle background.'],
  ['architecture', '`architecture/`', 'How the platform works **today** — present tense. A document here may not open by calling itself unbuilt.'],
  ['architecture/builder', '`architecture/builder/`', 'The builder subsystem — one plane, three documents.'],
  ['engines', '`engines/`', 'One per engine, mirroring `engines/*`.'],
  ['rfc', '`rfc/`', 'Open proposals. A document leaves when it is decided — to `architecture/` rewritten in present tense, or marked `superseded` / `historical` in place. One that never leaves is a signal.'],
  ['briefs', '`briefs/`', 'Handoffs with a short shelf life by design. They become `historical` once consumed.'],
  ['research', '`research/`', 'Dated snapshots of the outside world. Never revised.'],
  ['acceptance', '`acceptance/`', 'Agent-loop run records. **Closed** — the practice is retired (D-57); the records stay because later work cites them.'],
];

const index = [];
for (const [dir, title, blurb] of GROUPS) {
  const items = docs.filter((d) => d.dir === dir && d.base !== 'README.md')
    .sort((a, b) => a.base.localeCompare(b.base));
  if (!items.length) continue;
  const pre = dir === '.' ? '' : dir + '/';
  index.push('', `### ${title}`, '', blurb, '', '| document | status | |', '|---|---|---|',
    ...items.map((d) => `| [${d.base}](${pre}${d.base}) | \`${d.status}\` | ${d.description} |`));
}

const README = 'docs/README.md';
const readme = readFileSync(README, 'utf8');
const START =
  '<!-- INDEX:START — GENERATED by tools/docs-structure.mjs from the frontmatter of every docs/**/*.md — do not edit by hand; run `pnpm lint:docs` -->';
const END = '<!-- INDEX:END -->';
const block = [START, ...index, '', END].join('\n');
const has = readme.includes(START) && readme.includes(END);
if (!has) {
  errs.push(`${README}: missing ${START} / ${END} markers around the index`);
} else {
  // Spliced by index, not regex: the marker names `docs/**/*.md` and `**` is a regex quantifier.
  const from = readme.indexOf(START);
  const to = readme.indexOf(END, from) + END.length;
  const next = readme.slice(0, from) + block + readme.slice(to);
  if (next !== readme) {
    if (CHECK) errs.push(`${README}: the generated index is stale — run \`pnpm lint:docs\``);
    else { writeFileSync(README, next); console.log(`↻ ${README}: ${docs.length - 1} rows`); }
  }
}

/* ---- report ---- */
if (errs.length) {
  console.error(`✗ docs-structure: ${errs.length} problem${errs.length > 1 ? 's' : ''}`);
  for (const e of errs) console.error('  ' + e);
  process.exit(1);
}
const by = (s) => docs.filter((d) => d.status === s).length;
console.log(`✓ docs-structure: ${docs.length} documents · ` +
  Object.keys(STATUS).filter(by).map((s) => `${by(s)} ${s}`).join(' · '));
