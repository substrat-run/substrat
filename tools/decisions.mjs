#!/usr/bin/env node
/**
 * The decision-log emitter.
 *
 * `docs/decisions/*.md` is the source of truth. The tables in master-plan §12 and
 * kernel-design §14, and `docs/DECISIONS.md`, are all rendered FROM it — the same
 * emit-and-diff shape as `lint:permissions`, `lint:model` and `lint:api`.
 *
 *   node tools/decisions.mjs           # rewrite the generated blocks
 *   node tools/decisions.mjs --check   # CI: exit 1 if any generated block is stale
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';

const DIR = 'docs/decisions';
const README = 'docs/README.md';
const CHECK = process.argv.includes('--check');

/**
 * The closed status set. `proposed` renders as awaiting ratification; `superseded`
 * carries `superseded-by` naming the entry that replaced it, and renders as such on
 * every surface. Anything else is a typo the gate refuses — the README documented
 * `superseded` for months while nothing could parse it (#986).
 */
const STATUSES = ['accepted', 'proposed', 'superseded'];

/** A bracketed frontmatter list — `[D-2]`, `["K-18"]`, `[]` — as its ids. */
const list = s => (s ?? '').replace(/[[\]]/g, '').split(',').map(t => t.trim().replace(/"/g, '')).filter(Boolean);

/** Front-matter + body of one decision file. */
function read(file) {
  const src = readFileSync(join(DIR, file), 'utf8');
  const m = src.match(/^---\n([\s\S]*?)\n---\n+([\s\S]*)$/);
  if (!m) throw new Error(`${file}: no frontmatter`);
  const fm = Object.fromEntries(
    m[1].split('\n').filter(l => /^[\w-]+:/.test(l)).map(l => {
      const i = l.indexOf(':');
      return [l.slice(0, i), l.slice(i + 1).replace(/\s+#.*$/, '').trim().replace(/^"|"$/g, '')];
    }),
  );
  // Body = optional editorial blockquote (not part of the log row), then the decision,
  // then '## Why'. The blockquote is where a note to a human reader lives.
  const body = m[2].replace(/^# [^\n]*\n+/, '').replace(/^(?:>[^\n]*\n)+\n*/, '');
  const [decision, why] = body.split(/\n## Why\n\n/);
  if (why === undefined) throw new Error(`${file}: no '## Why' section`);
  return { ...fm, file, aliases: list(fm.aliases), amends: list(fm.amends), decision: decision.trim(), why: why.trim() };
}

const entries = readdirSync(DIR).filter(f => f.endsWith('.md')).map(read);

/* ---- integrity checks (the gate this replaces prose review with) ---- */
const errs = [];
const seen = new Map();
for (const e of entries) {
  for (const id of [e.id, ...e.aliases]) {
    if (seen.has(id)) errs.push(`id ${id} claimed by both ${seen.get(id)} and ${e.file}`);
    seen.set(id, e.file);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) errs.push(`${e.file}: bad date ${e.date}`);
  if (!['plan', 'kernel'].includes(e.layer)) errs.push(`${e.file}: bad layer ${e.layer}`);
  if (!STATUSES.includes(e.status)) errs.push(`${e.file}: bad status ${e.status} (one of ${STATUSES.join(' | ')})`);
  if (e.status === 'superseded' && !e['superseded-by']) errs.push(`${e.file}: status superseded without superseded-by`);
  if (e.status !== 'superseded' && e['superseded-by']) errs.push(`${e.file}: superseded-by ${e['superseded-by']} on a ${e.status} entry`);
}
for (const p of ['D', 'K']) {
  const ns = entries.filter(e => e.id.startsWith(p + '-')).map(e => +e.id.slice(2)).sort((a, b) => a - b);
  ns.forEach((n, i) => { if (i && n !== ns[i - 1] + 1) errs.push(`${p}: gap between ${ns[i - 1]} and ${n}`); });
}
// Every cross-reference names an entry that exists. `amends` and `superseded-by` are
// what make a later correction visible on the row it corrects, so a dangling one is
// worse than none: it says a back-pointer is rendered when nothing is.
for (const e of entries) {
  if (e.twin && !seen.has(e.twin)) errs.push(`${e.file}: twin ${e.twin} not found`);
  for (const id of e.amends) {
    if (!seen.has(id)) errs.push(`${e.file}: amends ${id} not found`);
    else if (seen.get(id) === e.file) errs.push(`${e.file}: amends itself`);
  }
  const by = e['superseded-by'];
  if (by && !seen.has(by)) errs.push(`${e.file}: superseded-by ${by} not found`);
  else if (by && seen.get(by) === e.file) errs.push(`${e.file}: superseded by itself`);
}

/* ---- render ---- */
// A table cell cannot hold a newline; collapse hard-wrapped prose back to one line.
const esc = s => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();

/**
 * Entries store relative links from `docs/decisions/`. Rendering one into a file in a
 * different directory has to rebase them, or every link in a generated table is wrong by
 * exactly the depth difference — which is how master-plan D-43 came to point at
 * `docs/docs/design/…`.
 */
const rebase = (text, targetFile) => text.replace(
  /\]\((\.[^)]*?\.md)((?:#[^)]*)?)\)/g,
  (_, href, hash) => `](${relative(dirname(targetFile), resolve(DIR, href)) || '.'}${hash})`,
);
const byNum = (a, b) => +a.id.slice(2) - +b.id.slice(2);

/** The entry an id (or alias) names — every id here has already passed the integrity check. */
const byFile = new Map(entries.map(e => [e.file, e]));
const byId = id => byFile.get(seen.get(id));
/** A link from a rendered surface to an entry's file. */
const linkTo = (t, target) => `[${t.id}](${relative(dirname(target), join(DIR, t.file))})`;

/**
 * The reverse of `amends`: the later entries that correct each row. Rendered on the
 * amended row, because that is the one a reader lands on — the amending entry already
 * says what it amends in its own prose, and nobody reading D-2 knows to look at D-57.
 */
const amendedBy = new Map();
for (const e of entries) for (const id of e.amends) {
  const t = byId(id);
  amendedBy.set(t.id, [...(amendedBy.get(t.id) ?? []), e]);
}
/** The reverse of `superseded-by`, for the index only — the replacing row's own prose says what it replaced. */
const supersedes = new Map();
for (const e of entries.filter(e => e.status === 'superseded')) {
  const t = byId(e['superseded-by']);
  supersedes.set(t.id, [...(supersedes.get(t.id) ?? []), e]);
}

const flag = e => (
  e.status === 'proposed' ? '**[awaiting ratification]** '
  : e.status === 'superseded' ? `**[superseded by ${byId(e['superseded-by']).id}]** `
  : '');

/**
 * The twin note. D-30/K-20, D-37/K-33 and D-45/K-37 are one decision written twice, at
 * the two altitudes kernel-design's header describes. They are cross-referenced rather
 * than collapsed: merging prose that restates itself differently is an editorial act, and
 * the reference is what a reader of either table actually needs — "this is the same
 * decision you may have already read", with somewhere to go.
 */
function twinNote(e, target) {
  if (!e.twin) return '';
  const t = byId(e.twin);
  return ` *(Restated at the other altitude as ${linkTo(t, target)} — same decision, ${t.layer === 'kernel' ? 'kernel' : 'plan'} layer.)*`;
}

/**
 * The back-pointers: what later entries did to this one. A superseded row names its
 * replacement; an amended row names each correction with its title, so the reader
 * sees *what* changed without opening it. The ledger is append-only, so this is the
 * only place the row can say it no longer reads as written.
 */
function laterNote(e, target) {
  const notes = [];
  if (e.status === 'superseded') notes.push(`Superseded by ${linkTo(byId(e['superseded-by']), target)}.`);
  for (const a of amendedBy.get(e.id) ?? []) notes.push(`Amended by ${linkTo(a, target)} — ${esc(a.title)}.`);
  return notes.length ? ` *(${notes.join(' ')})*` : '';
}
const row = (e, bare, target) =>
  `| ${bare ? e.id.slice(2) : e.id} | ${e.date} | ${flag(e)}${rebase(esc(e.decision), target)}${twinNote(e, target)}${laterNote(e, target)} | ${rebase(esc(e.why), target)} |`;

const targets = [
  { file: 'docs/master-plan.md', header: '| # | Date | Decision | Rationale |',
    rows: entries.filter(e => e.id.startsWith('D-')).sort(byNum).map(e => row(e, true, 'docs/master-plan.md')) },
  { file: 'docs/architecture/kernel-design.md', header: '| # | Date | Design decision | Notes |',
    rows: entries.filter(e => e.id.startsWith('K-')).sort(byNum).map(e => row(e, false, 'docs/architecture/kernel-design.md')) },
];

let stale = false;
for (const t of targets) {
  const lines = readFileSync(t.file, 'utf8').split('\n');
  const h = lines.indexOf(t.header);
  if (h < 0) throw new Error(`${t.file}: header not found`);
  let end = h + 2;
  while (end < lines.length && lines[end].startsWith('|')) end++;
  const current = lines.slice(h + 2, end).join('\n');
  const wanted = t.rows.join('\n');
  if (current === wanted) continue;
  stale = true;
  if (CHECK) {
    const a = current.split('\n'), b = wanted.split('\n');
    console.error(`✗ ${t.file}: generated table is stale (${a.length} rows on disk, ${b.length} generated)`);
    for (let i = 0; i < Math.max(a.length, b.length); i++)
      if (a[i] !== b[i]) { console.error(`  first difference at row ${i + 1}`); break; }
  } else {
    writeFileSync(t.file, [...lines.slice(0, h + 2), ...t.rows, ...lines.slice(end)].join('\n'));
    console.log(`↻ ${t.file}: ${t.rows.length} rows`);
  }
}

/* ---- docs/DECISIONS.md — the whole log, one place ---- */
/** The index shows a relation from both ends: `amends D-2` on D-57, `amended by D-57` on D-2. */
function indexNotes(e) {
  const notes = [];
  if (e.twin) notes.push(`restated as ${byId(e.twin).id}`);
  if (e.status === 'superseded') notes.push(`superseded by ${byId(e['superseded-by']).id}`);
  for (const s of supersedes.get(e.id) ?? []) notes.push(`supersedes ${s.id}`);
  if (e.amends.length) notes.push(`amends ${e.amends.map(id => byId(id).id).join(', ')}`);
  for (const a of amendedBy.get(e.id) ?? []) notes.push(`amended by ${a.id}`);
  return notes.map(n => ` <br>*${n}*`).join('');
}
const order = [...entries].sort((a, b) =>
  a.date.localeCompare(b.date) || a.id[0].localeCompare(b.id[0]) || +a.id.slice(2) - +b.id.slice(2));
const idx = [
  '<!-- GENERATED by tools/decisions.mjs — edit docs/decisions/*.md, not this file. -->',
  '# Decision log',
  '',
  'Every decision on the platform, both layers, oldest first. Each row links to the entry;',
  'the entry carries the full rationale.',
  '',
  '`D-*` are plan-layer decisions (strategy, architecture); `K-*` are kernel-layer (contracts,',
  'data models, lifecycles). The two sequences are historical — one log, two id vocabularies.',
  'See [rfc/docs-restructure.md](rfc/docs-restructure.md) §7.',
  '',
  `${entries.length} decisions · ${entries.filter(e => e.layer === 'plan').length} plan · ${entries.filter(e => e.layer === 'kernel').length} kernel`,
  '',
  '| id | date | layer | decision | tracking |',
  '|---|---|---|---|---|',
  ...order.map(e => `| [${e.id}](decisions/${e.file}) | ${e.date} | ${e.layer} | ${esc(e.title)}${indexNotes(e)} | ${(e.tracking || '').replace(/[[\]"]/g, '')} |`),
  '',
].join('\n');
if (CHECK) {
  let cur = ''; try { cur = readFileSync('docs/DECISIONS.md', 'utf8'); } catch {}
  if (cur !== idx) { console.error('✗ docs/DECISIONS.md is stale'); stale = true; }
} else { writeFileSync('docs/DECISIONS.md', idx); console.log('↻ docs/DECISIONS.md'); }

/* ---- docs/README.md — the entry count, so the prose cannot say 94 against 100 files ---- */
const COUNT = /(<!-- DECISIONS:COUNT -->)[^<]*(<!-- \/DECISIONS:COUNT -->)/;
{
  const cur = readFileSync(README, 'utf8');
  if (!COUNT.test(cur)) throw new Error(`${README}: DECISIONS:COUNT markers not found`);
  const next = cur.replace(COUNT, `$1${entries.length} entries$2`);
  if (next !== cur) {
    if (CHECK) { console.error(`✗ ${README}: the decision count is stale`); stale = true; }
    else { writeFileSync(README, next); console.log(`↻ ${README}: ${entries.length} entries`); }
  }
}

if (errs.length) { console.error('✗ integrity:\n' + errs.map(e => '  ' + e).join('\n')); process.exit(1); }
if (CHECK && stale) process.exit(1);
console.log(`✓ ${entries.length} decisions · ${entries.filter(e => e.layer === 'plan').length} plan · ${entries.filter(e => e.layer === 'kernel').length} kernel`);
