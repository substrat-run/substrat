/**
 * Every writer of an attachment row meets the orphan sweep's tombstone (#2314).
 *
 * The sweep deletes an object only after its scope tombstoned the id in
 * `_substrat_attachment_condemned`, and that is safe only because nothing can write an
 * `_substrat_attachments` row for a tombstoned id afterwards: the attachment insert calls
 * `refuseCondemnedAttachment` in its own transaction, and a dump load calls
 * `refuseCondemnedInDump` before its first drop. A new writer that skipped the check would let
 * a row commit whose bytes a pass is deleting, and every suite would stay green, because none of
 * them drives the new writer against a pass.
 *
 * **What this is, and is not.** A regression TRIPWIRE for a new writer, not a proof that none
 * exists. It reads text, so a writer spelled in a way it does not know (SQL assembled across
 * modules, a statement loaded from a file, a raw handle passed somewhere it cannot follow) gets
 * past it. The guarantee is held elsewhere, by mechanism and by tests:
 * - the condemned-id refusal runs inside each writer's own transaction (both adapters' attachment
 *   insert, which upload-link redemption shares, and both adapters' dump load);
 * - a pass deletes only an object its scope tombstoned first, in a transaction the insert is
 *   serialized against (`attachment-sweep.ts`).
 * `orphanSweepContractSuite` holds both on the pure adapter and on the Durable Object
 * (`packages/contract-tests/src/orphan-sweep-suite.ts`, run by both adapters' contract tests):
 * an upload held between its bytes and its row while a pass condemns it is refused and leaves no
 * row without bytes, and a dump that would bring back a condemned id is refused before anything is
 * dropped. The kernel's `attachment-sweep.test.ts` holds the refusal and the re-stamp on SQLite.
 *
 * So this reads the source:
 *
 * 1. an `INSERT`, `REPLACE` or `UPDATE` of `_substrat_attachments` needs its OWN
 *    `refuseCondemnedAttachment(` call: before it, in its function or a function enclosing it,
 *    and not already claimed by another writer. A guard in a sibling function does not count.
 *    The table is matched however it is spelled: quoted (`"x"`, `` `x` ``, `[x]`) and schema
 *    qualified (`main.x`, `"main"."x"`).
 * 2. a dump replay (`dumpRowsInsert(`, or any name it is imported or bound as) needs a
 *    `refuseCondemnedInDump(` call before it, in its function or a function enclosing it.
 * 3. an `INSERT` / `REPLACE` whose table is COMPUTED (interpolated, `INTO ${t}`; or a string that
 *    ends at INTO and is continued elsewhere: concatenated, kept as a prefix, array-joined) could
 *    name the attachments table and no text match would see it. It is refused unless a
 *    `refuseCondemnedInDump(` guard covers it the same way, or its file is in `COMPUTED_TARGETS`
 *    with the number of such sites and the reason none writes a scope's attachment rows. A file
 *    whose count differs from its entry, up or down, is refused, so a new loader added to a
 *    listed file is reviewed rather than waved through.
 * 4. an `ALTER TABLE … RENAME TO` the attachments table is a writer too (fill a temp table, then
 *    rename it).
 *
 * SQL comments between tokens are read as SQLite reads them (skipped); JS comments are blanked
 * first, so prose naming a statement is not a writer.
 *
 * "Function" is read off the tokens (`bare-regexp.mjs`'s lexer, so strings, templates, comments
 * and regex literals are skipped): a `{` after `=>`, or after a parameter list that is not an
 * `if`/`for`/`while`/`switch`/`catch`/`with` head, opens one. An expression-bodied arrow has no
 * braces and counts as part of the function around it.
 *
 * Shipped source only: tests write rows to set up what they assert, and `dumpRowsInsert`'s own
 * definition is not a load. Its fixtures are `attachment-writers.test.mjs`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { lex } from './bare-regexp.mjs';

/** SQL whitespace: blanks, and the comments SQLite skips between tokens (`/* … *\/`, `-- …`). */
const GAP = String.raw`(?:\s|/\*[\s\S]*?\*/|--[^\n]*(?:\n|$))`;
const _ = `${GAP}+`; // at least one
const __ = `${GAP}*`; // any
/** One identifier, as SQLite reads it: bare, or quoted with `"`, `` ` `` or `[]`. */
const IDENT = String.raw`(?:"[^"\n]+"|\[[^\]\n]+\]|\x60[^\x60\n]+\x60|\w+)`;
/** The attachments table, quoted or not, optionally schema qualified. */
const ATTACHMENTS = String.raw`(?:${IDENT}${__}\.${__})?(?:"_substrat_attachments"|\[_substrat_attachments\]|\x60_substrat_attachments\x60|_substrat_attachments(?![\w]))`;
const INTO = String.raw`(?:INSERT|REPLACE)${_}(?:OR${_}\w+${_})?INTO`;
const VERB = String.raw`(?:${INTO}|UPDATE(?:${_}OR${_}\w+)?|ALTER${_}TABLE${_}${IDENT}(?:${__}\.${__}${IDENT})?${_}RENAME${_}TO)`;
/** A statement that writes attachment rows: an INSERT, REPLACE or UPDATE of the table, or a
 *  table renamed INTO its name (a temp table filled, then renamed). */
const WRITER = new RegExp(String.raw`\b${VERB}${_}${ATTACHMENTS}`, 'gi');
/** An INSERT/REPLACE whose target is interpolated (`INTO ${t}`, `INTO "${t}"`, `INTO main.${t}`). */
const INTERPOLATED = new RegExp(String.raw`\b${INTO}${_}(?:${IDENT}${__}\.${__})?["\x60\[]?\$\{`, 'gi');
/**
 * An INSERT/REPLACE whose string ENDS at INTO: the target is added outside it, by concatenation
 * (`'INSERT INTO ' + t`), a prefix kept in a variable (`const p = 'INSERT INTO ';`), or an array
 * join (`['INSERT INTO', t].join(' ')`). What follows the closing quote is `+`, `,`, `;`, `)` or `]`.
 */
const CONCATENATED = new RegExp(String.raw`\b${INTO}${__}['"\x60]\s*[+,;)\]]`, 'gi');

/**
 * Files that build an INSERT whose table is computed: how many such SITES each has, and why none
 * writes a scope's attachment rows. Adding an entry, or a site to a listed file, is a reviewed act:
 * the lint refuses a file whose count differs from its entry, up or down.
 */
export const COMPUTED_TARGETS = {
  'packages/kernel/src/spine-restore.ts':
    { sites: 2, reason: 'builds the dump replay (dumpRowsInsert, held to refuseCondemnedInDump at every caller) and the control-plane directory load, which is no scope' },
  'packages/cli/src/scope.ts': { sites: 1, reason: 'writes a pulled scope into a local file the developer owns, not a scope store' },
  'packages/kernel/src/migration-replay.ts': { sites: 1, reason: 'replays migrations into a throwaway in-memory database to judge data loss' },
  'packages/kernel/src/derived-handlers.ts': { sites: 1, reason: "writes a module's own declared table through ctx.sql, which refuses every _substrat_* target (#954)" },
  'packages/kernel/src/entity-state.ts': { sites: 1, reason: "a constant naming the kernel's entity-state moves table" },
  'packages/kernel/src/table-ownership.ts': { sites: 1, reason: "a constant naming the kernel's table-ownership table" },
  'packages/kernel/src/system-switch-record.ts': { sites: 2, reason: "the kill switch's own record tables" },
  'packages/kernel/src/module-erasure.ts': { sites: 2, reason: "an FTS5 'secure-delete' control row on a search index" },
  'packages/kernel/src/search-index.ts': { sites: 5, reason: 'FTS5 index control rows and the triggers that keep a search index in step' },
  'scripts/lake-provision.mjs': { sites: 1, reason: 'an R2 SQL pipeline statement for the lake, not SQLite' },
  'packages/contract-tests/src/entity-state-module.ts': { sites: 2, reason: "a test fixture module writing its own tables" },
  'packages/contract-tests/src/entity-state-suite.ts': { sites: 1, reason: 'a test suite writing a fixture table through an operation' },
  'packages/contract-tests/src/shape-backfill-ties.ts': { sites: 2, reason: 'a test fixture writing its own tables' },
  'packages/contract-tests/src/shape-reconcile-plan.ts': { sites: 1, reason: 'a test fixture writing its own tables' },
};
const DEFINES_DUMP_ROWS = 'packages/kernel/src/spine-restore.ts';
const CONTROL_HEADS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);

/** Is this a shipped source file the rule reads? */
export function inScope(path) {
  if (!/\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(path) || /\.d\.[mc]?ts$/.test(path)) return false;
  if (/(?:^|\/)(?:test|tests|__tests__|dist|node_modules)\//.test(path)) return false;
  if (/\.(?:test|spec)\.[mc]?[jt]s$/.test(path)) return false;
  if (path.startsWith('tools/')) return false;
  return true;
}

/** Does the `{` at token `k` open a function body? */
function opensFunction(t, k) {
  const prev = t[k - 1];
  if (!prev) return false;
  if (prev.text === '>' && t[k - 2]?.text === '=') return true; // `=>`
  // Walk back over a return-type annotation (`): Promise<void> {`) to the parameter list's `)`.
  let j = k - 1;
  let depth = 0;
  for (; j >= 0; j -= 1) {
    const x = t[j];
    if (x.kind !== 'punct') continue;
    // An object-literal return type (`): { a: T } {`) is walked over like a generic: its `}` opens
    // a nesting and its `{` closes it. Whatever it is, only a `:` may then sit after the `)`.
    if (x.text === '>' || x.text === ']' || x.text === '}') depth += 1;
    else if (depth > 0 && (x.text === '<' || x.text === '[' || x.text === '{')) depth -= 1;
    else if (depth === 0 && x.text === ')') break;
    else if (depth === 0 && (x.text === ';' || x.text === '{' || x.text === '=' || x.text === ',')) return false;
  }
  if (j < 0) return false;
  // Only a type annotation may sit between the `)` and the `{`.
  if (j !== k - 1 && t[j + 1]?.text !== ':') return false;
  let paren = 0;
  for (; j >= 0; j -= 1) {
    if (t[j].text === ')') paren += 1;
    else if (t[j].text === '(' && (paren -= 1) === 0) break;
  }
  const head = t[j - 1];
  return !(head?.kind === 'word' && CONTROL_HEADS.has(head.text));
}

/**
 * Each token's chain of enclosing functions, innermost last, as ids. A token inside no function
 * has the empty chain (the module).
 */
export function functionChains(t) {
  const chains = new Array(t.length);
  const stack = []; // { fn: number | null }
  let nextFn = 1;
  const current = () => stack.filter((b) => b.fn !== null).map((b) => b.fn);
  for (let k = 0; k < t.length; k += 1) {
    const tok = t[k];
    if (tok.kind === 'punct' && tok.text === '{') {
      chains[k] = current();
      stack.push({ fn: opensFunction(t, k) ? nextFn++ : null });
      continue;
    }
    if (tok.kind === 'punct' && tok.text === '}') {
      stack.pop();
      chains[k] = current();
      continue;
    }
    chains[k] = current();
  }
  return chains;
}

/** The index of the token at or before line `line` that is a string starting on or before it. */
export function stringTokenAt(t, line) {
  let found = -1;
  for (let k = 0; k < t.length; k += 1) {
    if (t[k].line > line) break;
    if (t[k].kind === 'string') found = k;
  }
  return found;
}

export const callsOf = (t, name) =>
  t.flatMap((tok, k) => (tok.kind === 'word' && tok.text === name && t[k + 1]?.text === '(' ? [k] : []));

/** Does a guard at `g` cover a writer at `w`: before it, in its function or one enclosing it? */
export const covers = (chains, g, w) => {
  if (g >= w) return false;
  const gChain = chains[g];
  const inner = gChain[gChain.length - 1] ?? 0;
  const wChain = [0, ...chains[w]];
  return wChain.includes(inner);
};

/** Every name the dump replayer is reached by: its own, and each alias or binding of it. */
function replayerNames(files) {
  const names = new Set(['dumpRowsInsert']);
  for (const { text } of files) {
    for (const m of text.matchAll(/\bdumpRowsInsert\s+as\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*)\s*[:=]\s*dumpRowsInsert\b(?!\s*\()/g)) names.add(m[1]);
    // A destructuring rename, `{ dumpRowsInsert: dri }` (the key first, the binding after).
    for (const m of text.matchAll(/\bdumpRowsInsert\s*:\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  }
  return names;
}

export const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/**
 * The source with its JS comments blanked (newlines kept, so lines and offsets hold): prose that
 * names a statement, as a doc comment listing `INSERT`/`REPLACE INTO` does, is not a writer.
 * Strings and templates (with their `${…}`) are kept whole; a SQL comment inside one is SQL.
 */
export function blankComments(text) {
  let out = '';
  let i = 0;
  const templates = []; // brace depth inside each open `${`
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? text.length : end;
      out += blank(text.slice(i, stop));
      i = stop;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += blank(text.slice(i, stop));
      i = stop;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '`' || (c === '}' && templates.length > 0 && templates[templates.length - 1] === 0)) {
      if (c === '}') templates.pop();
      let j = i + 1;
      for (; j < text.length; j += 1) {
        if (text[j] === '\\') { j += 1; continue; }
        if (text[j] === '`') break;
        if (text[j] === '$' && text[j + 1] === '{') { templates.push(0); j += 1; break; }
      }
      out += text.slice(i, j + 1);
      i = j + 1;
    } else {
      if (templates.length > 0) {
        if (c === '{') templates[templates.length - 1] += 1;
        else if (c === '}') templates[templates.length - 1] -= 1;
      }
      out += c;
      i += 1;
    }
  }
  return out;
}

/** The offences in `files` ([{ path, text }]), as `path:line: why` strings. */
export function findBypasses(files, computedTargets = COMPUTED_TARGETS) {
  const out = [];
  const replayers = replayerNames(files);
  const computing = new Map();
  for (const { path, text: source } of files) {
    if (!inScope(path)) continue;
    const text = blankComments(source);
    const writers = [...text.matchAll(WRITER)];
    const computed = [...text.matchAll(INTERPOLATED), ...text.matchAll(CONCATENATED)];
    if (computed.length > 0) computing.set(path, computed.length);
    const replayCalls = path === DEFINES_DUMP_ROWS ? [] : [...replayers].filter((n) => new RegExp(`\\b${n.replace(/\$/g, '\\$')}\\s*\\(`).test(text));
    if (writers.length === 0 && computed.length === 0 && replayCalls.length === 0 && !text.includes('dumpRowsInsert')) continue;
    const t = lex(text);
    const chains = functionChains(t);

    const guards = callsOf(t, 'refuseCondemnedAttachment');
    const claimed = new Set();
    for (const match of writers) {
      const line = lineOf(text, match.index);
      const w = stringTokenAt(t, line);
      // The nearest unclaimed guard that covers this writer.
      const g = w < 0 ? undefined : guards.filter((k) => !claimed.has(k) && covers(chains, k, w)).at(-1);
      if (g === undefined) {
        out.push(`${path}:${line}: an attachment row is written without its own refuseCondemnedAttachment() before it, in its function`);
      } else {
        claimed.add(g);
      }
    }

    const dumpGuards = callsOf(t, 'refuseCondemnedInDump');
    // A replayer reached by a computed member (`kernel['dumpRowsInsert']`) is a replay site too.
    if (path !== DEFINES_DUMP_ROWS) {
      for (const m of text.matchAll(/\[\s*['"\x60]dumpRowsInsert['"\x60]\s*\]/g)) {
        const line = lineOf(text, m.index);
        const r = stringTokenAt(t, line);
        if (r < 0 || !dumpGuards.some((g) => covers(chains, g, r))) {
          out.push(`${path}:${line}: a dump load replays rows without refuseCondemnedInDump() before them, in its function`);
        }
      }
    }
    for (const name of replayers) {
      for (const r of callsOf(t, name)) {
        if (path === DEFINES_DUMP_ROWS) continue;
        if (!dumpGuards.some((g) => covers(chains, g, r))) {
          out.push(`${path}:${t[r].line}: a dump load replays rows without refuseCondemnedInDump() before them, in its function`);
        }
      }
    }

    if (!(path in computedTargets)) {
      for (const match of computed) {
        const line = lineOf(text, match.index);
        const w = stringTokenAt(t, line);
        if (w >= 0 && dumpGuards.some((g) => covers(chains, g, w))) continue;
        out.push(
          `${path}:${line}: an INSERT whose table is computed could write attachment rows unseen; ` +
            'guard it with refuseCondemnedInDump() or name the file in COMPUTED_TARGETS with its reason',
        );
      }
    }
  }
  // Each entry is pinned to its SITE count: a new computed INSERT added to a listed file (the
  // replay module is the likeliest home of the next loader) is refused until the entry is
  // reviewed, and so is a site that went away.
  for (const [path, entry] of Object.entries(computedTargets)) {
    if (!files.some((f) => f.path === path)) continue;
    const found = computing.get(path) ?? 0;
    if (found === 0) {
      out.push(`${path}: is in COMPUTED_TARGETS but computes no INSERT target any more; remove the entry`);
    } else if (found !== entry.sites) {
      out.push(
        `${path}: COMPUTED_TARGETS allows ${entry.sites} computed INSERT site(s) and the file has ${found}; ` +
          'review each one and update the count',
      );
    }
  }
  return out;
}

function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const paths = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((p) => p && inScope(p));
  const files = paths.map((path) => ({ path, text: readFileSync(new URL(`../${path}`, import.meta.url), 'utf8') }));
  const offences = findBypasses(files);
  if (offences.length > 0) {
    console.error(
      'lint:attachment-writers — a writer of attachment rows that skips the orphan sweep\'s tombstone (#2314):\n' +
        offences.map((o) => `  ${o}`).join('\n'),
    );
    process.exit(1);
  }
  console.log(`lint:attachment-writers — ${files.length} files read, every attachment writer checks the tombstone`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
