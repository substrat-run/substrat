#!/usr/bin/env node
/**
 * The weekly changelog's raw material, and its completeness checkpoint.
 *
 * `apps/docs/changelog/` is the one part of the published docs that is *authored*
 * rather than emitted — a digest of a week's merges, written for someone building
 * on Substrat rather than for someone reading `git log`. So it gets no
 * `.generated.ts` suffix and no re-emit gate: there is no producer that could
 * write the prose, and marking it generated while nothing regenerates it is the
 * failure mode `CLAUDE.md` names outright.
 *
 * One thing about it *is* mechanical, though, and it is the thing that will rot:
 * **completeness**. A week is 90–130 first-parent merges. An author — human or
 * agent — who silently drops thirty of them produces a page that looks finished
 * and is wrong, and nobody notices, because the only way to notice is to redo the
 * work. That is what `--check` asserts: every PR merged inside an entry's declared
 * range is cited somewhere on its page.
 *
 * It deliberately does NOT assert the reverse. A highlight that cites the issue it
 * closes, or last week's PR for context, is citing something outside the range on
 * purpose. Missing is a defect; extra is editing.
 *
 * The second mechanical thing is the one that keeps getting mistaken for a defect:
 * an entry states its week **twice**, and the two statements use opposite
 * conventions. Frontmatter `range:` is half-open — `2026-08-17..2026-08-24` is
 * Monday to Monday, the end *excluded* — because that is what a git range wants.
 * The H1 is prose for a reader, so it is inclusive: "17–23 August 2026". They are
 * supposed to disagree by a day, and #988 filed the disagreement as drift. So the
 * relation is checked rather than commented: `--check` derives the heading's span
 * from the declared range and refuses if they part company, in either direction.
 *
 * The third is the absence the first two cannot see. Coverage is asserted *inside*
 * a declared range, so a week nobody wrote has no range and draws no complaint —
 * #988 was filed because a reader noticed a missing week and CI could not. So
 * `--check` also holds the entries to a contiguous run of **settled** weeks: a week
 * is settled once the week after it has ended too, which exempts the newest complete
 * week and therefore never argues with the Monday parking rule. See the comment at
 * the check itself for why this is a week grid rather than a staleness threshold.
 *
 *   node tools/changelog-week.mjs                 # the last complete week, as raw material
 *   node tools/changelog-week.mjs --week 2026-w34 # a named week
 *   node tools/changelog-week.mjs --check         # CI: every entry accounts for its range
 *
 * `--check` reads history, so it is meaningless on the shallow checkout Actions
 * gives by default — and a check that cannot check must fail rather than pass. It
 * refuses to run on a shallow clone; the CI job sets `fetch-depth: 0`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRIES = join(ROOT, 'apps/docs/changelog');

/**
 * Week boundaries are Stockholm's, not the runner's.
 *
 * Git reads a naive `--since` in the local zone, so the same range would select a
 * different set of commits on a developer's laptop and on a UTC runner — a
 * two-hour window at each end where a merge belongs to a different week depending
 * on who asks. Pinning the zone makes the answer the same everywhere.
 */
const TZ = 'Europe/Stockholm';

const git = (...args) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, TZ } }).trim();

/** The Monday of an ISO week, as `YYYY-MM-DD`. */
function mondayOfIsoWeek(year, week) {
  // Jan 4th is always in ISO week 1, so it anchors the calendar without a table.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const isoDay = jan4.getUTCDay() || 7;
  const week1Monday = Date.UTC(year, 0, 4 - (isoDay - 1));
  const monday = new Date(week1Monday + (week - 1) * 7 * 86_400_000);
  return monday.toISOString().slice(0, 10);
}

/** `2026-08-17` → `2026-08-24`. Ranges are half-open: Monday to Monday. */
function addDays(iso, days) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The week before `id`. `2026-w01` → `2025-w52`, off the calendar rather than a table. */
function previousWeek(id) {
  return isoWeekOf(addDays(weekRange(id).start, -7));
}

/** The ISO week id — `2026-w34` — a date falls in. */
function isoWeekOf(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day); // the Thursday decides the year
  const year = d.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((d - jan1) / 86_400_000 + 1) / 7);
  return `${year}-w${String(week).padStart(2, '0')}`;
}

/** Today's calendar date in the pinned zone, as `YYYY-MM-DD`. */
function todayIn(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
}

/**
 * The last week that has fully ended — never the one still in progress. "Today" is
 * Stockholm's, like every other boundary here: at 23:30 UTC on a Sunday it is already
 * Monday in Stockholm, and the week that just ended is the one to write.
 */
function lastCompleteWeek() {
  const today = todayIn(TZ);
  const day = new Date(`${today}T00:00:00Z`).getUTCDay() || 7;
  const thisMonday = addDays(today, -(day - 1));
  return isoWeekOf(addDays(thisMonday, -7));
}

/** `2026-w34` → `{ id, start, end }`, end exclusive. */
function weekRange(id) {
  const m = /^(\d{4})-w(\d{2})$/.exec(id);
  if (!m) throw new Error(`not a week id: ${id} (expected 2026-w34)`);
  const start = mondayOfIsoWeek(Number(m[1]), Number(m[2]));
  // `2026-w00` and `2026-w54` parse, and map onto some other week's Monday; a filename
  // carrying one would pass the range check while duplicating a real week's coverage.
  if (isoWeekOf(start) !== id) throw new Error(`not an ISO week: ${id}`);
  return { id, start, end: addDays(start, 7) };
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * The date span an entry's H1 claims, as `{ from, to }` ISO dates — inclusive, the
 * way prose reads. Every published entry writes it one of two ways, depending on
 * whether the week straddles a month:
 *
 *   # Week 34 · 17–23 August 2026
 *   # Week 31 · 27 July – 2 August 2026
 *
 * The month, and the year, are stated once when they are the same on both sides.
 * A span that runs over New Year states its own year on the left; without one, a
 * left month later in the calendar than the right month is the previous year.
 *
 * Returns `undefined` when the heading carries no span at all — the caller reports
 * that, because an entry whose heading does not say which week it is is exactly
 * what this check exists to catch.
 */
function headingSpanOf(src) {
  const h1 = /^#[ \t]+(.+)$/m.exec(src);
  if (!h1) return undefined;
  const m = /(\d{1,2})(?:\s+([A-Za-z]+))?(?:\s+(\d{4}))?\s*[–—-]\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/
    .exec(h1[1]);
  if (!m) return undefined;

  const [, d1, name1, year1, d2, name2, year2] = m;
  const to = MONTHS.indexOf(name2);
  const from = name1 ? MONTHS.indexOf(name1) : to;
  if (from < 0 || to < 0) return undefined;

  const iso = (y, month, day) => `${y}-${String(month + 1).padStart(2, '0')}-${day.padStart(2, '0')}`;
  const fromYear = year1 ? Number(year1) : Number(year2) - (from > to ? 1 : 0);
  return { from: iso(fromYear, from, d1), to: iso(Number(year2), to, d2) };
}

/**
 * A squash merge's subject ends in the PR that landed it — `… (#866) (#899)` is
 * issue #866, merged by #899. Anything earlier is an issue reference, so the
 * *last* number is the only one that identifies the merge.
 */
function prNumberOf(subject) {
  const all = [...subject.matchAll(/#(\d+)/g)];
  return all.length ? Number(all[all.length - 1][1]) : undefined;
}

/** The conventional-commit scope, for grouping. `feat(kernel,adapters): …` → kernel. */
function areaOf(subject) {
  const m = /^(\w+)(?:\(([^)]+)\))?!?:/.exec(subject);
  if (!m) return 'other';
  if (m[2]) return m[2].split(',')[0].trim();
  return m[1] === 'docs' || m[1] === 'ci' || m[1] === 'chore' ? m[1] : 'other';
}

/** Every first-parent commit in a range, classified. */
function commitsIn({ start, end }) {
  const raw = git(
    'log', '--first-parent', `--since=${start} 00:00`, `--until=${end} 00:00`,
    '--format=%H%x1f%ad%x1f%s', '--date=format-local:%Y-%m-%d',
  );
  if (!raw) return [];
  return raw.split('\n').map((line) => {
    const [sha, date, subject] = line.split('\x1f');
    const release = /^Version packages\b/.test(subject);
    const plumbing = /^Merge branch\b/.test(subject);
    return { sha, date, subject, release, plumbing, pr: prNumberOf(subject), area: areaOf(subject) };
  });
}

/** Per package, the first and last version tagged inside the range, in commit order. */
function releasesIn(range) {
  const spans = new Map();
  for (const c of commitsIn(range).slice().reverse()) {
    if (!c.release) continue;
    for (const tag of git('tag', '--points-at', c.sha).split('\n').filter(Boolean)) {
      const at = tag.lastIndexOf('@');
      const [name, version] = [tag.slice(0, at), tag.slice(at + 1)];
      const span = spans.get(name);
      if (span) span.to = version;
      else spans.set(name, { from: version, to: version });
    }
  }
  return [...spans.entries()].sort(([a], [b]) => a.localeCompare(b));
}

// ── report ────────────────────────────────────────────────────────────────────

function report(id) {
  const range = weekRange(id);
  const commits = commitsIn(range);
  const merges = commits.filter((c) => !c.plumbing && !c.release);
  const direct = merges.filter((c) => c.pr === undefined);

  console.log(`# ${id} — ${range.start} to ${addDays(range.end, -1)}\n`);
  console.log(
    `${merges.length} merges, ${commits.filter((c) => c.release).length} releases, ` +
      `${direct.length} pushed without a PR.\n`,
  );

  const byArea = new Map();
  for (const c of merges) byArea.set(c.area, [...(byArea.get(c.area) ?? []), c]);
  for (const [area, list] of [...byArea].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`## ${area} (${list.length})`);
    for (const c of list) console.log(`  ${c.date}  ${c.pr ? `#${c.pr}` : '  —  '}  ${c.subject}`);
    console.log('');
  }

  const spans = releasesIn(range);
  if (spans.length) {
    console.log(`## released (${spans.length} packages)`);
    for (const [name, { from, to }] of spans) {
      console.log(`  ${name}  ${from === to ? from : `${from} → ${to}`}`);
    }
  }
}

// ── check ─────────────────────────────────────────────────────────────────────

function check() {
  if (git('rev-parse', '--is-shallow-repository') === 'true') {
    console.error(
      'changelog: this is a shallow clone, so the history a range selects is not the ' +
        'history that exists. Nothing can be verified. Set `fetch-depth: 0` on the checkout.',
    );
    process.exit(1);
  }

  const files = existsSync(ENTRIES)
    ? readdirSync(ENTRIES).filter((f) => f.endsWith('.md') && f !== 'index.md').sort()
    : [];
  if (!files.length) {
    console.error(`changelog: no entries in apps/docs/changelog/`);
    process.exit(1);
  }

  const problems = [];
  for (const file of files) {
    const src = readFileSync(join(ENTRIES, file), 'utf8');
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src);
    const declared = fm && /^range:\s*(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})\s*$/m.exec(fm[1]);
    if (!declared) {
      problems.push(`${file}: no \`range: YYYY-MM-DD..YYYY-MM-DD\` in frontmatter (end exclusive)`);
      continue;
    }
    const range = { start: declared[1], end: declared[2] };

    // The filename is a claim about which week this is; hold it to the range.
    const id = file.replace(/\.md$/, '');
    const expected = weekRange(id);
    if (expected.start !== range.start || expected.end !== range.end) {
      problems.push(
        `${file}: named ${id} (${expected.start}..${expected.end}) but declares ` +
          `${range.start}..${range.end}`,
      );
      continue;
    }

    // The H1 states the same week a second time, for a reader rather than for git,
    // so it is inclusive where the range is half-open. Off by exactly one day is
    // the correct answer here, and #988 read it as drift — hence the check.
    const heading = headingSpanOf(src);
    const inclusive = { from: range.start, to: addDays(range.end, -1) };
    if (!heading) {
      problems.push(
        `${file}: the H1 names no date span — it should restate the range inclusively, ` +
          `as \`# Week ${Number(id.slice(-2))} · …\` covering ${inclusive.from} to ${inclusive.to}`,
      );
    } else if (heading.from !== inclusive.from || heading.to !== inclusive.to) {
      problems.push(
        `${file}: the H1 says ${heading.from}..${heading.to} but \`range: ${range.start}..` +
          `${range.end}\` (end exclusive) is ${inclusive.from}..${inclusive.to}. The range is ` +
          `half-open and the heading is inclusive, so they differ by one day on purpose — ` +
          `fix whichever of the two is actually wrong, not the convention`,
      );
    }

    const cited = new Set([...src.matchAll(/#(\d+)/g)].map((m) => Number(m[1])));
    const merges = commitsIn(range).filter((c) => !c.plumbing && !c.release);
    const missing = merges.filter((c) => c.pr !== undefined && !cited.has(c.pr));
    const direct = merges.filter((c) => c.pr === undefined);

    if (missing.length) {
      problems.push(
        `${file}: ${missing.length} of ${merges.length} merges are not accounted for — ` +
          `the page reads as complete and is not:\n` +
          missing.map((c) => `      #${c.pr}  ${c.subject}`).join('\n'),
      );
    }
    if (direct.length) {
      // Not a failure: a commit pushed straight to main has no PR to cite, so the
      // author has to decide what to say about it. Naming them is the whole help.
      console.log(
        `${file}: ${direct.length} commit(s) landed without a PR and cannot be cited:\n` +
          direct.map((c) => `      ${c.date}  ${c.subject}`).join('\n'),
      );
    }
  }

  // ── the week that is not there ──────────────────────────────────────────────
  //
  // Everything above judges an entry that exists. The one failure none of it can
  // see is an entry that does not: coverage is asserted *inside* each declared
  // range, so a week nobody wrote has no range, no page and no complaint — which
  // is how #988 came to be filed by a reader rather than by CI.
  //
  // The obvious shape — "the newest entry is younger than N days" — collides head
  // on with how these are written. The Monday playbook opens a PR and never merges
  // it, and an entry must not merge before its week has ended, so the newest week
  // is *legitimately* absent from `main` for however long that review takes. Any N
  // is then a guess about review latency, and a wrong guess reddens `main` on a
  // schedule, which is the one thing a gate must never do.
  //
  // So the question asked here has no tunable in it: **which weeks are settled?** A
  // week is settled once the week after it has also ended — by then its Monday run
  // has been and gone with a full week to spare, and no entry still in review can
  // be the one accounting for it. Every settled week from the first entry onward
  // must be on disk. The newest complete week is exempt by construction, and that
  // is exactly the week parking is about.
  //
  // Two costs, stated rather than hidden. A missing week is reported up to two
  // weeks late — late is still infinitely sooner than never. And this is the only
  // assertion in this file whose answer depends on the day it runs; it is the
  // irreducible part of noticing an absence, not an oversight.
  const weeks = files
    .map((f) => f.replace(/\.md$/, ''))
    .filter((id) => {
      try {
        weekRange(id);
        return true;
      } catch {
        return false; // not a week id; the per-file pass above is what reports it
      }
    })
    .sort();

  if (weeks.length) {
    const present = new Set(weeks);
    const settledThrough = previousWeek(lastCompleteWeek());
    const stop = weekRange(settledThrough).start;
    const missing = [];
    for (let cursor = weekRange(weeks[0]).start; cursor <= stop; cursor = addDays(cursor, 7)) {
      const id = isoWeekOf(cursor);
      if (!present.has(id)) missing.push(id);
    }
    if (missing.length) {
      problems.push(
        `${missing.length} settled week(s) have no entry: ${missing.join(', ')}\n` +
          `      Every week from ${weeks[0]} through ${settledThrough} should have one. ` +
          `${settledThrough} is the\n` +
          `      newest *settled* week — the week after it has ended too, so no entry ` +
          `still in review\n` +
          `      can be the one covering it. Write each with \`node tools/changelog-week.mjs ` +
          `--week <id>\`\n` +
          `      for the raw material; a week that genuinely had nothing to say still gets ` +
          `a page saying so.`,
      );
    }
  }

  if (problems.length) {
    console.error(`changelog: ${problems.length} problem(s)\n`);
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error('');
    process.exit(1);
  }
  console.log(
    `changelog: ${files.length} entr(ies), every merge in range accounted for, ` +
      `no settled week missing through ${previousWeek(lastCompleteWeek())}.`,
  );
}

const args = process.argv.slice(2);
if (args.includes('--check')) check();
else {
  const at = args.indexOf('--week');
  report(at >= 0 ? args[at + 1] : lastCompleteWeek());
}
