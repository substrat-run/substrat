#!/usr/bin/env node
/**
 * A LIKE or GLOB pattern written into source is at most 50 bytes (#1655).
 *
 * A Durable Object's SQLite sets `SQLITE_LIMIT_LIKE_PATTERN_LENGTH` to 50. Stock SQLite
 * allows 50 000, so a longer pattern runs everywhere a suite can reach and fails, as
 * `LIKE or GLOB pattern too complex`, only on the hosted scope. Ticket0's snooze sweep
 * shipped a 92-byte GLOB that way and `ticket0/wake-snoozed` failed every run on every
 * hosted desk, with every suite green (#1646).
 *
 * That is two checks, and this is the cheap half of them:
 *
 *  - `tools/vitest/like-pattern-limit.cjs` makes every node suite enforce the limit at
 *    RUN time — it is what catches a pattern built from input, which no source scan can
 *    know the length of. It is on for `pnpm test` and for CI.
 *  - This reads the SOURCE, so a literal over the limit is refused on a path no test
 *    happens to execute: the branch a suite never reaches is exactly where #1646 lived.
 *
 * What it reads is a `LIKE` or `GLOB` keyword followed by a quoted SQL string —
 * `WHERE v GLOB '…'`, `NOT LIKE '…' ESCAPE '\\'` — inside any string, template or
 * migration file under a workspace member's source. The pattern's length is counted the
 * way SQLite counts it, in UTF-8 BYTES of the text between the quotes with `''` read as one
 * quote. A `${…}` interpolation counts as nothing, so the figure is a lower bound: this
 * never accuses a pattern the runtime would accept, and never claims a built one is short.
 *
 * That is the shape a pattern is WRITTEN in when it is inline. The one that actually shipped in
 * #1646 was not: it was a `const` of character classes bound as `GLOB ?`, where no keyword
 * sits beside the literal. A second reading therefore looks for the constant itself — a
 * quoted string over the limit that is a run of three or more bracket classes
 * (`[0-9][0-9]…`), holds no whitespace and no backslash, and so reads as a GLOB rather than
 * prose, a path or a regular expression. It is a heuristic and says so: a longer pattern
 * with no classes, or a `%…%` constant, is the runtime limit's to catch.
 *
 * Text, not an AST, and comments are not stripped: a loud false positive beats a silent
 * pass, and a line that has one can say `like-pattern-allow: <reason>` in a comment — the
 * reason is required, and the line is then not read.
 *
 * Not read: `test/` (a suite may hold a long pattern on purpose — a split guard's oracle
 * is one), the browser apps (`web`, `app`: no SQL runs there), and build output.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** A Durable Object's `SQLITE_LIMIT_LIKE_PATTERN_LENGTH`, in bytes. */
const LIMIT = 50;

const ROOTS = ['packages', 'engines', 'connectors', 'demos', 'apps'];
const SOURCE = /\.(?:ts|mts|js|mjs|sql)$/;
const SKIP_FILE = /\.(?:d\.ts|test\.[cm]?[jt]s|generated\.json)$|\.generated\./;
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.wrangler',
  '.builder',
  'test',
  'tests',
  '__tests__',
  'fixtures',
  'web',
  'app',
]);

/** A line opts out, and it has to give a reason. */
const ALLOW = /like-pattern-allow:\s*\S/;

/**
 * `LIKE '…'` / `GLOB '…'`, the quote optionally backslash-escaped because the SQL sits in a
 * JS single-quoted string. The body is `[^']` or a doubled `''`, and stops at the first lone
 * quote. `\b` on both sides keeps `dislike '…'` and `LIKED '…'` out.
 */
const LITERAL = /\b(?:LIKE|GLOB)\s+(\\?)'((?:[^']|'')*)'/gi;

/** Any quoted string on a line — the body is what a GLOB constant is judged on. */
const QUOTED = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;

/** One bracket class as a GLOB writes it: `[0-9]`, `[a-z]`, `[!x]`, `[^x]`. */
const CLASS = /\[[^\]\s]{1,12}\]/g;

/** A string that reads as a GLOB: three or more classes, and nothing that says prose, a path or a regexp. */
const globShaped = (body) =>
  !/[\s\\]/.test(body) && (body.match(CLASS) ?? []).length >= 3;

/** The bytes SQLite would count for the text of one SQL literal as written in source. */
const patternBytes = (body) =>
  new TextEncoder().encode(
    body
      .replace(/\$\{[^}]*\}/g, '') // an interpolation: unknown, counted as nothing
      .replace(/''/g, "'") // SQL's own quote escape
      .replace(/\\(.)/g, '$1'), // a JS escape: `\\_` is one byte, and so is `\'`
  ).length;

/**
 * Every over-limit literal in one file's text, as `{ line, bytes, text }`.
 * The scan is per line, so a literal split across lines by string concatenation is not
 * joined — a pattern that long is written on purpose and is the runtime limit's to catch.
 */
const overLimit = (source) => {
  const out = [];
  const lines = source.split('\n');
  lines.forEach((line, i) => {
    if (ALLOW.test(line)) return;
    for (const m of line.matchAll(LITERAL)) {
      // Opened as `\'`, it closes as `\'`: the backslash before the closing quote is the
      // JS escape, not part of the pattern.
      const body = m[1] === '\\' ? m[2].replace(/\\$/, '') : m[2];
      const bytes = patternBytes(body);
      if (bytes > LIMIT) out.push({ line: i + 1, bytes, text: body });
    }
    for (const m of line.matchAll(QUOTED)) {
      const bytes = patternBytes(m[2]);
      // The same literal can be both a keyword's argument and glob-shaped: once is enough.
      if (bytes > LIMIT && globShaped(m[2]) && !out.some((o) => o.line === i + 1 && o.text === m[2])) {
        out.push({ line: i + 1, bytes, text: m[2] });
      }
    }
  });
  return out;
};

const walk = (dir, out = []) => {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (SKIP_DIRS.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (SOURCE.test(e) && !SKIP_FILE.test(e)) out.push(p);
  }
  return out;
};

/**
 * The predicate, judged against every shape it exists to tell apart, on every run and
 * before the tree is read — the same reason `lint:vite-proxy` carries one. A text rule
 * drifts silently when a regex is tidied, and a check that has stopped checking is green.
 * [source, offenders expected].
 */
const a = (n) => 'a'.repeat(n);
const SELF_CHECK = [
  // The boundary, both sides of it: the limit passes and one byte over does not.
  [`WHERE v GLOB '${a(50)}'`, 0],
  [`WHERE v GLOB '${a(51)}'`, 1],
  [`WHERE v LIKE '${a(50)}'`, 0],
  [`WHERE v LIKE '${a(51)}'`, 1],
  [`WHERE v NOT LIKE '${a(51)}' ESCAPE '\\'`, 1],
  // Any case, since SQLite reads any case.
  [`where v glob '${a(51)}'`, 1],
  // In a JS single-quoted string the SQL quote is backslash-escaped.
  [`'WHERE v GLOB \\'${a(51)}\\''`, 1],
  [`'WHERE v GLOB \\'${a(50)}\\''`, 0],
  // Bytes, not characters: 25 two-byte characters are the limit, 26 are over it.
  [`WHERE v LIKE '${'é'.repeat(25)}'`, 0],
  [`WHERE v LIKE '${'é'.repeat(26)}'`, 1],
  // A doubled quote is one byte, so 25 pairs are 25 bytes and do not add up to 50 by accident.
  [`WHERE v LIKE '${"''".repeat(25)}'`, 0],
  [`WHERE v LIKE '${"''".repeat(26)}${a(25)}'`, 1],
  // A JS escape is one byte: `\\_` is a backslash and an underscore in the value.
  [`WHERE v LIKE '${'\\\\_'.repeat(25)}' ESCAPE '\\\\'`, 0],
  // An interpolation counts as nothing, so a built pattern is never accused for its holes.
  [`WHERE v LIKE '\${prefix}${a(50)}'`, 0],
  [`WHERE v LIKE '\${prefix}${a(51)}'`, 1],
  // The #1646 shape: the guard as it shipped, 92 bytes.
  [
    `WHERE at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'`,
    1,
  ],
  // The shape that shipped: a constant of classes, bound as `GLOB ?`, no keyword beside it.
  [`const WHOLE =\n  '${'[0-9]'.repeat(11)}';`, 1], // 55 bytes
  [`const PIECE = '${'[0-9]'.repeat(10)}';`, 0], // 50 bytes: the limit passes
  [`const WHOLE = "${'[0-9]'.repeat(11)}";`, 1],
  [`const WHOLE = \`${'[0-9]'.repeat(11)}\`;`, 1],
  // Three classes are what make it a GLOB, and prose, regexps and paths are not one.
  [`const LOOKS = '[a][b]${'x'.repeat(60)}';`, 0],
  [`const RE = '${'[0-9]'.repeat(11)}\\d';`, 0],
  [`const USAGE = 'usage: ${'[a-z]'.repeat(11)}';`, 0],
  // The words as words: not a keyword followed by a literal.
  [`// a value like '${a(60)}' is refused`, 1], // a comment is read, on purpose — say so with an allow
  [`const dislike = '${a(60)}';`, 0],
  [`WHERE v LIKE ?`, 0],
  [`WHERE v LIKE '%' || ? || '%'`, 0],
  // The reasoned opt-out, and only with a reason.
  [`WHERE v GLOB '${a(51)}' -- like-pattern-allow: a maintenance read on node only`, 0],
  [`WHERE v GLOB '${a(51)}' -- like-pattern-allow:`, 1],
  // Two on one line are both read.
  [`v LIKE '${a(51)}' OR v GLOB '${a(52)}'`, 2],
];
const drift = SELF_CHECK.filter(([src, want]) => overLimit(src).length !== want);
if (drift.length > 0) {
  console.error('like-pattern: the rule no longer tells its own cases apart — fix the predicate before trusting a run:');
  for (const [src, want] of drift) {
    console.error(`  expected ${want} offender(s), got ${overLimit(src).length}: ${src.slice(0, 120)}`);
  }
  process.exit(2);
}

const files = ROOTS.flatMap((r) => walk(r));
if (files.length === 0) {
  console.error(`like-pattern: no source found under ${ROOTS.join('/, ')}/ — the check would pass by scanning nothing.`);
  process.exit(2);
}

const offenders = [];
for (const file of files) {
  for (const o of overLimit(readFileSync(file, 'utf8'))) {
    offenders.push(`${file}:${o.line}: ${o.bytes} bytes — ${o.text.slice(0, 60)}${o.text.length > 60 ? '…' : ''}`);
  }
}

if (offenders.length > 0) {
  console.error(`like-pattern: a LIKE/GLOB pattern over ${LIMIT} bytes runs on node and fails on a Durable Object (#1655, #1646).`);
  console.error('  Split it into pieces of at most 50 bytes joined with AND, or move the test out of SQL.');
  for (const o of offenders) console.error(`  ${o}`);
  process.exit(1);
}
console.log(`like-pattern: ok (${files.length} source files read, no LIKE/GLOB literal over ${LIMIT} bytes)`);
