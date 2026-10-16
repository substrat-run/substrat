/**
 * Every writer of an attachment row meets the orphan sweep's tombstone (#2314).
 *
 * The sweep deletes an object only after its scope tombstoned the id in
 * `_substrat_attachment_condemned`, and that is safe only because nothing can write an
 * `_substrat_attachments` row for a tombstoned id afterwards: the attachment insert calls
 * `refuseCondemnedAttachment` in its own transaction, and a dump load calls
 * `refuseCondemnedInDump` before its first drop. A new writer that skipped the check would let
 * a row commit whose bytes a pass is deleting, and every suite would stay green, because none of
 * them drives the new writer against a pass. So this reads the source:
 *
 * 1. an `INSERT`, `REPLACE` or `UPDATE` of `_substrat_attachments` needs its OWN
 *    `refuseCondemnedAttachment(` call: before it, in its function or a function enclosing it,
 *    and not already claimed by another writer. A guard in a sibling function does not count.
 *    The table is matched however it is spelled: quoted (`"x"`, `` `x` ``, `[x]`) and schema
 *    qualified (`main.x`, `"main"."x"`).
 * 2. a dump replay (`dumpRowsInsert(`, or any name it is imported or bound as) needs a
 *    `refuseCondemnedInDump(` call before it, in its function or a function enclosing it.
 * 3. an `INSERT` / `REPLACE` whose table is COMPUTED (interpolated, `INTO ${t}`, or concatenated,
 *    `'INSERT INTO ' + t`) could name the attachments table and no text match would see it. It is
 *    refused unless a `refuseCondemnedInDump(` guard covers it the same way, or its file is in
 *    `COMPUTED_TARGETS` with the reason it never writes a scope's attachment rows. An entry whose
 *    file no longer computes a target is refused too, so the list cannot rot.
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

/** One identifier, as SQLite reads it: bare, or quoted with `"`, `` ` `` or `[]`. */
const IDENT = String.raw`(?:"[^"\n]+"|\[[^\]\n]+\]|\x60[^\x60\n]+\x60|\w+)`;
/** The attachments table, quoted or not, optionally schema qualified. */
const ATTACHMENTS = String.raw`(?:${IDENT}\s*\.\s*)?(?:"_substrat_attachments"|\[_substrat_attachments\]|\x60_substrat_attachments\x60|_substrat_attachments(?![\w]))`;
const VERB = String.raw`(?:(?:INSERT|REPLACE)\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?)`;
const WRITER = new RegExp(String.raw`\b${VERB}\s+${ATTACHMENTS}`, 'gi');
/** An INSERT/REPLACE whose target is interpolated (`INTO ${t}`, `INTO "${t}"`, `INTO main.${t}`). */
const INTERPOLATED = new RegExp(String.raw`\b(?:INSERT|REPLACE)\s+(?:OR\s+\w+\s+)?INTO\s+(?:${IDENT}\s*\.\s*)?["\x60\[]?\$\{`, 'gi');
/** An INSERT/REPLACE whose string ends at INTO and is concatenated (`'INSERT INTO ' + t`). */
const CONCATENATED = /\b(?:INSERT|REPLACE)\s+(?:OR\s+\w+\s+)?INTO\s*['"`]\s*\+/gi;

/**
 * Files that build an INSERT whose table is computed, each with why it never writes a scope's
 * attachment rows. Adding one is a reviewed act; an entry whose file stops computing a target is
 * refused (`stale`).
 */
export const COMPUTED_TARGETS = {
  'packages/kernel/src/spine-restore.ts':
    'builds the dump replay (dumpRowsInsert, held to refuseCondemnedInDump at every caller) and the control-plane directory load, which is no scope',
  'packages/cli/src/scope.ts': 'writes a pulled scope into a local file the developer owns, not a scope store',
  'packages/kernel/src/migration-replay.ts': 'replays migrations into a throwaway in-memory database to judge data loss',
  'packages/kernel/src/derived-handlers.ts': "writes a module's own declared table through ctx.sql, which refuses every _substrat_* target (#954)",
  'packages/kernel/src/entity-state.ts': "a constant naming the kernel's entity-state moves table",
  'packages/kernel/src/table-ownership.ts': "a constant naming the kernel's table-ownership table",
  'packages/kernel/src/system-switch-record.ts': "the kill switch's own record tables",
  'packages/kernel/src/module-erasure.ts': "an FTS5 'secure-delete' control row on a search index",
  'packages/kernel/src/search-index.ts': 'FTS5 index control rows and the triggers that keep a search index in step',
  'scripts/lake-provision.mjs': 'an R2 SQL pipeline statement for the lake, not SQLite',
  'packages/contract-tests/src/entity-state-module.ts': "a test fixture module writing its own tables",
  'packages/contract-tests/src/entity-state-suite.ts': 'a test suite writing a fixture table through an operation',
  'packages/contract-tests/src/shape-backfill-ties.ts': 'a test fixture writing its own tables',
  'packages/contract-tests/src/shape-reconcile-plan.ts': 'a test fixture writing its own tables',
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
    if (x.text === '>' || x.text === ']') depth += 1;
    else if (x.text === '<' || x.text === '[') depth -= 1;
    else if (depth === 0 && x.text === ')') break;
    else if (depth === 0 && (x.text === ';' || x.text === '{' || x.text === '}' || x.text === '=' || x.text === ',')) return false;
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
function functionChains(t) {
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
function stringTokenAt(t, line) {
  let found = -1;
  for (let k = 0; k < t.length; k += 1) {
    if (t[k].line > line) break;
    if (t[k].kind === 'string') found = k;
  }
  return found;
}

const callsOf = (t, name) =>
  t.flatMap((tok, k) => (tok.kind === 'word' && tok.text === name && t[k + 1]?.text === '(' ? [k] : []));

/** Does a guard at `g` cover a writer at `w`: before it, in its function or one enclosing it? */
const covers = (chains, g, w) => {
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
  }
  return names;
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/** The offences in `files` ([{ path, text }]), as `path:line: why` strings. */
export function findBypasses(files, computedTargets = COMPUTED_TARGETS) {
  const out = [];
  const replayers = replayerNames(files);
  const computing = new Set();
  for (const { path, text } of files) {
    if (!inScope(path)) continue;
    const writers = [...text.matchAll(WRITER)];
    const computed = [...text.matchAll(INTERPOLATED), ...text.matchAll(CONCATENATED)];
    if (computed.length > 0) computing.add(path);
    const replayCalls = path === DEFINES_DUMP_ROWS ? [] : [...replayers].filter((n) => new RegExp(`\\b${n.replace(/\$/g, '\\$')}\\s*\\(`).test(text));
    if (writers.length === 0 && computed.length === 0 && replayCalls.length === 0) continue;
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
  for (const path of Object.keys(computedTargets)) {
    if (files.some((f) => f.path === path) && !computing.has(path)) {
      out.push(`${path}: is in COMPUTED_TARGETS but computes no INSERT target any more; remove the entry`);
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
