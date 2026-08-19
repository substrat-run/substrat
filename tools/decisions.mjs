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
const CHECK = process.argv.includes('--check');

/** Front-matter + body of one decision file. */
function read(file) {
  const src = readFileSync(join(DIR, file), 'utf8');
  const m = src.match(/^---\n([\s\S]*?)\n---\n+([\s\S]*)$/);
  if (!m) throw new Error(`${file}: no frontmatter`);
  const fm = Object.fromEntries(
    m[1].split('\n').filter(l => /^\w+:/.test(l)).map(l => {
      const i = l.indexOf(':');
      return [l.slice(0, i), l.slice(i + 1).replace(/\s+#.*$/, '').trim().replace(/^"|"$/g, '')];
    }),
  );
  // Body = optional editorial blockquote (not part of the log row), then the decision,
  // then '## Why'. The blockquote is where a note to a human reader lives.
  const body = m[2].replace(/^# [^\n]*\n+/, '').replace(/^(?:>[^\n]*\n)+\n*/, '');
  const [decision, why] = body.split(/\n## Why\n\n/);
  if (why === undefined) throw new Error(`${file}: no '## Why' section`);
  return { ...fm, file, decision: decision.trim(), why: why.trim() };
}

const entries = readdirSync(DIR).filter(f => f.endsWith('.md')).map(read);

/* ---- integrity checks (the gate this replaces prose review with) ---- */
const errs = [];
const seen = new Map();
for (const e of entries) {
  for (const id of [e.id, ...(e.aliases?.replace(/[[\]]/g, '').split(',').map(s => s.trim().replace(/"/g, '')).filter(Boolean) || [])]) {
    if (seen.has(id)) errs.push(`id ${id} claimed by both ${seen.get(id)} and ${e.file}`);
    seen.set(id, e.file);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) errs.push(`${e.file}: bad date ${e.date}`);
  if (!['plan', 'kernel'].includes(e.layer)) errs.push(`${e.file}: bad layer ${e.layer}`);
}
for (const p of ['D', 'K']) {
  const ns = entries.filter(e => e.id.startsWith(p + '-')).map(e => +e.id.slice(2)).sort((a, b) => a - b);
  ns.forEach((n, i) => { if (i && n !== ns[i - 1] + 1) errs.push(`${p}: gap between ${ns[i - 1]} and ${n}`); });
}
for (const e of entries) if (e.twin && !seen.has(e.twin)) errs.push(`${e.file}: twin ${e.twin} not found`);

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
const flag = e => (e.status === 'proposed' ? '**[awaiting ratification]** ' : '');

/**
 * The twin note. D-30/K-20, D-37/K-33 and D-45/K-37 are one decision written twice, at
 * the two altitudes kernel-design's header describes. They are cross-referenced rather
 * than collapsed: merging prose that restates itself differently is an editorial act, and
 * the reference is what a reader of either table actually needs — "this is the same
 * decision you may have already read", with somewhere to go.
 */
const byId = new Map(entries.map(e => [e.id, e]));
function twinNote(e, target) {
  if (!e.twin) return '';
  const t = byId.get(e.twin);
  const href = relative(dirname(target), join(DIR, t.file));
  return ` *(Restated at the other altitude as [${t.id}](${href}) — same decision, ${t.layer === 'kernel' ? 'kernel' : 'plan'} layer.)*`;
}
const row = (e, bare, target) =>
  `| ${bare ? e.id.slice(2) : e.id} | ${e.date} | ${flag(e)}${rebase(esc(e.decision), target)}${twinNote(e, target)} | ${rebase(esc(e.why), target)} |`;

const targets = [
  { file: 'docs/master-plan.md', header: '| # | Date | Decision | Rationale |',
    rows: entries.filter(e => e.id.startsWith('D-')).sort(byNum).map(e => row(e, true, 'docs/master-plan.md')) },
  { file: 'docs/design/kernel-design.md', header: '| # | Date | Design decision | Notes |',
    rows: entries.filter(e => e.id.startsWith('K-')).sort(byNum).map(e => row(e, false, 'docs/design/kernel-design.md')) },
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
  'See [proposals/docs-restructure.md](proposals/docs-restructure.md) §7.',
  '',
  `${entries.length} decisions · ${entries.filter(e => e.layer === 'plan').length} plan · ${entries.filter(e => e.layer === 'kernel').length} kernel`,
  '',
  '| id | date | layer | decision | tracking |',
  '|---|---|---|---|---|',
  ...order.map(e => `| [${e.id}](decisions/${e.file}) | ${e.date} | ${e.layer} | ${esc(e.title)}${e.twin ? ` <br>*restated as ${e.twin}*` : ''} | ${(e.tracking || '').replace(/[[\]"]/g, '')} |`),
  '',
].join('\n');
if (CHECK) {
  let cur = ''; try { cur = readFileSync('docs/DECISIONS.md', 'utf8'); } catch {}
  if (cur !== idx) { console.error('✗ docs/DECISIONS.md is stale'); stale = true; }
} else { writeFileSync('docs/DECISIONS.md', idx); console.log('↻ docs/DECISIONS.md'); }

if (errs.length) { console.error('✗ integrity:\n' + errs.map(e => '  ' + e).join('\n')); process.exit(1); }
if (CHECK && stale) process.exit(1);
console.log(`✓ ${entries.length} decisions · ${entries.filter(e => e.layer === 'plan').length} plan · ${entries.filter(e => e.layer === 'kernel').length} kernel`);
