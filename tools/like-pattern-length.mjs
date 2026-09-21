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
 * `WHERE v GLOB '…'`, `NOT LIKE '…' ESCAPE '\\'` — inside a string or template literal of a
 * `.ts`/`.js` file, or in a `.sql` file. A JS string is DECODED first (`\u00e9` is two bytes,
 * `\${x}` is four, a line continuation is nothing), because SQLite counts the pattern the
 * program builds, not the characters typed; a `.sql` file is read raw, backslashes and all.
 * The pattern's length is then counted the way SQLite counts it, in UTF-8 BYTES of the text
 * between the quotes with `''` read as one quote. An unescaped `${…}` counts as nothing, so
 * the figure is a lower bound: this never accuses a pattern the runtime would accept.
 *
 * It fails CLOSED where it cannot read: a `LIKE '` whose literal is not closed inside its own
 * string (`"… GLOB '" + x + "'"`, a pattern built across pieces) is reported as unreadable
 * rather than skipped, and the message says to split it or opt out.
 *
 * That is the shape a pattern is WRITTEN in when it is inline. The one that actually shipped in
 * #1646 was not: it was a `const` of character classes bound as `GLOB ?`, where no keyword
 * sits beside the literal. A second reading therefore looks for the constant itself — a
 * quoted string over the limit that is a run of three or more bracket classes
 * (`[0-9][0-9]…`), holds no whitespace and no backslash, and so reads as a GLOB rather than
 * prose, a path or a regular expression. It is a heuristic and says so: a longer pattern
 * with no classes, or a `%…%` constant, is the runtime limit's to catch.
 *
 * A loud false positive beats a silent pass, so a quoted message that happens to read
 * `like '…60 bytes…'` is refused too. A literal opts out with `like-pattern-allow: <reason>`
 * in a COMMENT — a JS comment, or a `--` or block comment in a `.sql` file — on the line the
 * literal starts or ends on, or on the line above. The marker is read from comment tokens
 * only, with the delimiters stripped before the reason is tested, so a string that mentions it
 * opts nothing out and an opt-out with nothing after the colon is an empty reason, as in `lint:module-inputs`.
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

/** A comment's opt-out; the delimiters are already gone, so a bare closing star-slash cannot read as a reason. */
const ALLOW = /like-pattern-allow:[^\S\n]*\S/;

/** `LIKE '…'` / `GLOB '…'` in decoded text; group 2 is empty when the literal never closes. */
const LITERAL = /\b(?:LIKE|GLOB)\s+'((?:[^']|'')*)('?)/gi;

/** One bracket class as a GLOB writes it — of any width: `[0-9]`, `[a-z]`, `[!x]`, `[^x]`. */
const CLASS = /\[[^\]\s]+\]/g;

/** Three or more classes and nothing that says prose, a path or a regexp: reads as a GLOB. */
const globShaped = (text) => !/[\s\\]/.test(text) && (text.match(CLASS) ?? []).length >= 3;

const bytesOf = (text) => new TextEncoder().encode(text).length;
const lineAt = (src, i) => src.slice(0, i).split('\n').length;

/** The index just past the `}` closing the `{` of a `${` at `i` — quotes and nested templates skipped. */
const skipInterpolation = (src, i) => {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return j + 1;
    else if (c === "'" || c === '"') j = skipQuoted(src, j, c) - 1;
    else if (c === '`') j = skipQuoted(src, j, c) - 1;
  }
  return src.length;
};

/** The index just past the string or template opened at `i`, `${…}` and escapes stepped over. */
const skipQuoted = (src, i, quote) => {
  for (let j = i + 1; j < src.length; ) {
    if (src[j] === '\\') j += 2;
    else if (src[j] === quote) return j + 1;
    else if (quote === '`' && src[j] === '$' && src[j + 1] === '{') j = skipInterpolation(src, j + 1);
    else j++;
  }
  return src.length;
};

/**
 * A JS/TS file split into code, string, comment and regular-expression tokens — the same
 * reading `lint:module-inputs` does, for the same reasons: a `'http://…'` whose `//` a comment
 * strip would take for a comment, a regexp whose quotes are ordinary characters, and a comment,
 * which is the only place an opt-out is read from. A `/` is a regexp after an operator or a
 * keyword and a division after a value.
 */
const VALUE_BEFORE = /[\w$)\]]$/;
const KEYWORD_BEFORE = /\b(?:return|typeof|instanceof|in|of|case|new|delete|void|do|else|yield|await)$/;
const jsTokens = (src) => {
  const out = [];
  let tail = '';
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    const next = src[i + 1];
    let end;
    let kind;
    if (c === '/' && next === '/') {
      end = src.indexOf('\n', i);
      end = end === -1 ? src.length : end;
      kind = 'comment';
    } else if (c === '/' && next === '*') {
      end = src.indexOf('*/', i + 2);
      end = end === -1 ? src.length : end + 2;
      kind = 'comment';
    } else if (c === "'" || c === '"' || c === '`') {
      end = skipQuoted(src, i, c);
      kind = 'string';
    } else if (c === '/' && (!VALUE_BEFORE.test(tail.trimEnd()) || KEYWORD_BEFORE.test(tail.trimEnd()))) {
      end = i + 1;
      for (let inClass = false; end < src.length && src[end] !== '\n'; ) {
        if (src[end] === '\\') end += 2;
        else if (src[end] === '[') (inClass = true), end++;
        else if (src[end] === ']') (inClass = false), end++;
        else if (src[end] === '/' && !inClass) break;
        else end++;
      }
      end = Math.min(end + 1, src.length);
      kind = 'regex';
    } else {
      tail = (tail + c).slice(-24);
      i++;
      continue;
    }
    const raw = src.slice(i, end);
    out.push({ kind, raw, start: i, end, startLine: lineAt(src, i), endLine: lineAt(src, end - 1) });
    if (kind !== 'comment') tail = (tail + 'X').slice(-24);
    i = end;
  }
  return out;
};

/** What a string token's value is once the program has built it: escapes decoded, `${…}` dropped. */
const decode = (raw) => {
  const quote = raw[0];
  const inner = raw.slice(1, raw.endsWith(quote) && raw.length > 1 ? -1 : undefined);
  let out = '';
  for (let i = 0; i < inner.length; ) {
    const c = inner[i];
    if (c === '$' && inner[i + 1] === '{' && quote === '`') i = skipInterpolation(inner, i + 1);
    else if (c !== '\\') (out += c), i++;
    else {
      const n = inner[i + 1];
      const hex = (len) => String.fromCharCode(parseInt(inner.slice(i + 2, i + 2 + len), 16));
      if (n === 'u' && inner[i + 2] === '{') {
        const close = inner.indexOf('}', i);
        out += String.fromCodePoint(parseInt(inner.slice(i + 3, close), 16));
        i = close + 1;
      } else if (n === 'u') (out += hex(4)), (i += 6);
      else if (n === 'x') (out += hex(2)), (i += 4);
      else if (n === '\n') i += 2; // a line continuation is nothing
      else if (n === '\r') i += inner[i + 2] === '\n' ? 3 : 2;
      else (out += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' }[n] ?? n), (i += 2);
    }
  }
  return out;
};

/** A `.sql` file's comment and string tokens: `--` to end of line, block comments, `'…'` (`''` escapes). */
const sqlTokens = (src) => {
  const out = [];
  const re = /--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:[^']|'')*(?:'|$)/g;
  for (const m of src.matchAll(re)) {
    const end = m.index + m[0].length;
    out.push({
      kind: m[0][0] === "'" ? 'string' : 'comment',
      raw: m[0],
      start: m.index,
      end,
      startLine: lineAt(src, m.index),
      endLine: lineAt(src, end - 1),
    });
  }
  return out;
};

/** Comment text with its delimiters stripped, so the reason is judged on what was written. */
const commentText = (raw) => raw.replace(/^(?:\/\/|--|\/\*)/, '').replace(/\*\/$/, '');

/**
 * Every offender in one file's text: `{ line, bytes, text }` over the limit, or `{ line, text,
 * unreadable: true }` for a `LIKE '` whose literal does not close inside its own string. `kind`
 * is 'js' or 'sql'. An offender is dropped when a reasoned comment sits on the line its string
 * starts or ends on, or the line above.
 */
const scan = (source, kind) => {
  const tokens = kind === 'sql' ? sqlTokens(source) : jsTokens(source);
  const allowed = new Set();
  for (const t of tokens) {
    if (t.kind !== 'comment' || !ALLOW.test(commentText(t.raw))) continue;
    for (let l = t.startLine; l <= t.endLine + 1; l++) allowed.add(l);
  }
  const out = [];
  const add = (t, line, found) => {
    if (allowed.has(t.startLine) || allowed.has(t.endLine)) return;
    if (!out.some((o) => o.line === line && o.text === found.text)) out.push({ line, ...found });
  };
  /** The LIKE/GLOB literals in `text`, which begins on line `base`; `t` is the string they sit in, or null. */
  const readLiterals = (t, text, base) => {
    for (const m of text.matchAll(LITERAL)) {
      const line = base + text.slice(0, m.index).split('\n').length - 1;
      const bytes = bytesOf(m[1].replace(/''/g, "'"));
      const where = t ?? { startLine: line, endLine: line };
      if (m[2] === '') add(where, line, { text: m[1], unreadable: true });
      else if (bytes > LIMIT) add(where, line, { text: m[1], bytes });
    }
  };
  if (kind === 'sql') {
    // Raw, so a backslash is a byte; comments blanked (same length, newlines kept) before reading.
    let text = source;
    for (const t of tokens) {
      if (t.kind === 'comment') text = text.slice(0, t.start) + text.slice(t.start, t.end).replace(/[^\n]/g, ' ') + text.slice(t.end);
    }
    readLiterals(null, text, 1);
    return out;
  }
  for (const t of tokens) {
    if (t.kind !== 'string') continue;
    const value = decode(t.raw);
    readLiterals(t, value, t.startLine);
    if (globShaped(value) && bytesOf(value) > LIMIT) add(t, t.startLine, { text: value, bytes: bytesOf(value) });
  }
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
 * [source, kind, offenders expected].
 */
const a = (n) => 'a'.repeat(n);
const js = (src, want) => [src, 'js', want];
const sql = (src, want) => [src, 'sql', want];
const SELF_CHECK = [
  // The boundary, both sides of it: the limit passes and one byte over does not.
  js(`q = "WHERE v GLOB '${a(50)}'";`, 0),
  js(`q = "WHERE v GLOB '${a(51)}'";`, 1),
  js(`q = "WHERE v LIKE '${a(50)}'";`, 0),
  js(`q = "WHERE v LIKE '${a(51)}'";`, 1),
  js(`q = "WHERE v NOT LIKE '${a(51)}' ESCAPE '\\\\'";`, 1),
  js(`q = "where v glob '${a(51)}'";`, 1), // SQLite reads any case
  js(`q = 'WHERE v GLOB \\'${a(51)}\\'';`, 1), // the SQL quote escaped inside a JS single-quoted string
  js(`q = 'WHERE v GLOB \\'${a(50)}\\'';`, 0),
  // Bytes, not characters: 25 two-byte characters are the limit, 26 are over it.
  js(`q = "WHERE v LIKE '${'é'.repeat(25)}'";`, 0),
  js(`q = "WHERE v LIKE '${'é'.repeat(26)}'";`, 1),
  // A doubled quote is one byte.
  js(`q = "WHERE v LIKE '${"''".repeat(25)}'";`, 0),
  js(`q = "WHERE v LIKE '${"''".repeat(26)}${a(25)}'";`, 1),
  // JS escapes are decoded: \u00e9 is one character of two bytes, \x41 one of one, \u{1F600} four.
  js(`q = "WHERE v LIKE '${'\\u00e9'.repeat(25)}'";`, 0),
  js(`q = "WHERE v LIKE '${'\\u00e9'.repeat(26)}'";`, 1),
  js(`q = "WHERE v LIKE '${'\\x41'.repeat(50)}'";`, 0),
  js(`q = "WHERE v LIKE '${'\\x41'.repeat(51)}'";`, 1),
  js(`q = "WHERE v LIKE '${'\\u{1F600}'.repeat(12)}'";`, 0), // 48 bytes
  js(`q = "WHERE v LIKE '${'\\u{1F600}'.repeat(13)}'";`, 1), // 52 bytes
  // An escaped placeholder is four literal bytes; an unescaped one in a template is nothing.
  js(`q = \`WHERE v LIKE '${a(47)}\\\${x}'\`;`, 1),
  js(`q = \`WHERE v LIKE '${a(46)}\\\${x}'\`;`, 0),
  js(`q = \`WHERE v LIKE '\${prefix}${a(50)}'\`;`, 0),
  js(`q = \`WHERE v LIKE '\${prefix}${a(51)}'\`;`, 1),
  js(`q = \`WHERE v LIKE '\${fn(\`nested\`, "}")}${a(51)}'\`;`, 1), // a nested template does not end it early
  // A literal split across lines is read whole: by a template, and by a line continuation.
  js(`q = \`WHERE v LIKE\n  '${a(51)}'\`;`, 1),
  js(`q = \`WHERE v LIKE\n  '${a(50)}'\`;`, 0),
  js(`q = 'WHERE v LIKE \\'${a(30)}\\\n${a(21)}\\'';`, 1),
  js(`q = 'WHERE v LIKE \\'${a(30)}\\\n${a(20)}\\'';`, 0),
  // Fail closed: a literal built across pieces cannot be measured, so it is refused, not skipped.
  js(`q = "WHERE v GLOB '" + pattern + "'";`, 1),
  js(`q = "WHERE v LIKE '" + a + "' AND w LIKE ?";`, 1),
  js(`q = "WHERE v LIKE ?";`, 0),
  js(`q = "WHERE v LIKE '%' || ? || '%'";`, 0),
  // The shape that shipped: a constant of classes, bound as \`GLOB ?\`, no keyword beside it.
  js(`const WHOLE =\n  '${'[0-9]'.repeat(11)}';`, 1), // 55 bytes
  js(`const PIECE = '${'[0-9]'.repeat(10)}';`, 0), // 50 bytes: the limit passes
  js(`const WHOLE = "${'[0-9]'.repeat(11)}";`, 1),
  js(`const WHOLE = \`${'[0-9]'.repeat(11)}\`;`, 1),
  // A class of any width counts: three 20-character classes are 66 bytes, and a class cap would miss them.
  js(`const WIDE = '${'[abcdefghijklmnopqrst]'.repeat(3)}';`, 1),
  js(`const WIDE = '${'[abcdefghijklmnopqrst]'.repeat(2)}';`, 0), // 44 bytes and two classes
  // Three classes are what make it a GLOB; prose, regexps and paths are not.
  js(`const LOOKS = '[a][b]${a(60)}';`, 0),
  js(`const RE = '${'[0-9]'.repeat(11)}\\\\d';`, 0),
  js(`const USAGE = 'usage: ${'[a-z]'.repeat(11)}';`, 0),
  // The reasoned opt-out lives in a COMMENT, on the line the string starts or ends on, or above it.
  js(`// like-pattern-allow: a maintenance read that runs on node only\nq = "WHERE v GLOB '${a(51)}'";`, 0),
  js(`q = "WHERE v GLOB '${a(51)}'"; // like-pattern-allow: a maintenance read`, 0),
  js(`/* like-pattern-allow: a maintenance read */ q = "WHERE v GLOB '${a(51)}'";`, 0),
  js(`q = \`WHERE v GLOB\n  '${a(51)}'\`; // like-pattern-allow: node-only`, 0),
  js(`// like-pattern-allow: a reason\n\nq = "WHERE v GLOB '${a(51)}'";`, 1), // two lines away: not this literal's
  js(`// like-pattern-allow:\nq = "WHERE v GLOB '${a(51)}'";`, 1), // no reason
  js(`/* like-pattern-allow: */\nq = "WHERE v GLOB '${a(51)}'";`, 1), // the closing star is not a reason
  js(`/* like-pattern-allow:\n */\nq = "WHERE v GLOB '${a(51)}'";`, 1),
  // A string that MENTIONS the marker opts nothing out.
  js(`note = "like-pattern-allow: written about, not decided"; q = "WHERE v GLOB '${a(51)}'";`, 1),
  js(`q = "WHERE v GLOB '${a(51)}' -- like-pattern-allow: inside the string";`, 1),
  // A comment is not code: prose there is not read, and a regexp's quote does not open a string.
  js(`// a value like '${a(60)}' is refused\nq = 1;`, 0),
  js(`re = /'/; q = "WHERE v GLOB '${a(51)}'";`, 1),
  js(`u = 'http://x'; q = "WHERE v GLOB '${a(51)}'";`, 1),
  js(`const dislike = '${a(60)}';`, 0),
  js(`q = "v LIKE '${a(51)}' OR v GLOB '${a(52)}'";`, 2),
  // A .sql file is read raw: a backslash is a byte, so the escapes JS decodes are not decoded.
  sql(`SELECT 1 WHERE v LIKE '${a(50)}';`, 0),
  sql(`SELECT 1 WHERE v LIKE '${a(51)}';`, 1),
  sql(`SELECT 1 WHERE v LIKE '${'\\_'.repeat(25)}' ESCAPE '\\';`, 0), // 50 bytes, backslashes kept
  sql(`SELECT 1 WHERE v LIKE '${'\\_'.repeat(26)}' ESCAPE '\\';`, 1),
  sql(`SELECT 1 WHERE v LIKE '${'\\u00e9'.repeat(9)}';`, 1), // 54 raw bytes; JS would decode it to 18
  sql(`SELECT 1 WHERE v LIKE\n  '${a(51)}';`, 1),
  sql(`SELECT 1 WHERE v LIKE '${a(30)}\n${a(21)}';`, 1),
  sql(`-- like-pattern-allow: node only\nSELECT 1 WHERE v LIKE '${a(51)}';`, 0),
  sql(`SELECT 1 WHERE v LIKE '${a(51)}'; -- like-pattern-allow: node only`, 0),
  sql(`/* like-pattern-allow: */\nSELECT 1 WHERE v LIKE '${a(51)}';`, 1),
  sql(`SELECT 'like-pattern-allow: mention' WHERE v LIKE '${a(51)}';`, 1),
  sql(`-- a value like '${a(60)}'\nSELECT 1;`, 0),
];
const drift = SELF_CHECK.filter(([src, kind, want]) => scan(src, kind).length !== want);
if (drift.length > 0) {
  console.error('like-pattern: the rule no longer tells its own cases apart — fix the predicate before trusting a run:');
  for (const [src, kind, want] of drift) {
    console.error(`  expected ${want} offender(s), got ${scan(src, kind).length} (${kind}): ${JSON.stringify(src).slice(0, 140)}`);
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
  for (const o of scan(readFileSync(file, 'utf8'), file.endsWith('.sql') ? 'sql' : 'js')) {
    const shown = `${o.text.slice(0, 60)}${o.text.length > 60 ? '…' : ''}`;
    offenders.push(
      o.unreadable
        ? `${file}:${o.line}: a LIKE/GLOB literal that never closes inside its own string — built across pieces, so its length is unknown (${shown})`
        : `${file}:${o.line}: ${o.bytes} bytes — ${shown}`,
    );
  }
}

if (offenders.length > 0) {
  console.error(`like-pattern: a LIKE/GLOB pattern over ${LIMIT} bytes runs on node and fails on a Durable Object (#1655, #1646).`);
  console.error('  Split it into pieces of at most 50 bytes joined with AND, bind it whole from one string, or opt out with');
  console.error('  a `like-pattern-allow: <reason>` comment on the line above (a pattern the scan cannot join must say why it is safe).');
  for (const o of offenders) console.error(`  ${o}`);
  process.exit(1);
}
console.log(`like-pattern: ok (${files.length} source files read, no LIKE/GLOB literal over ${LIMIT} bytes)`);
