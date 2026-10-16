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
 * 1. an `INSERT` / `REPLACE` into `_substrat_attachments` needs its OWN
 *    `refuseCondemnedAttachment(` call: before it, in its function or a function enclosing it,
 *    and not already claimed by another insert. A guard in a sibling function does not count.
 * 2. a dump replay (`dumpRowsInsert(`) needs a `refuseCondemnedInDump(` call before it, in its
 *    function or a function enclosing it.
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

const INSERT = /\b(?:INSERT|REPLACE)\s+(?:OR\s+\w+\s+)?INTO\s+["`]?_substrat_attachments\b(?!_)/gi;
const DEFINES_DUMP_ROWS = 'packages/kernel/src/spine-restore.ts';
const CONTROL_HEADS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);

/** Is this a shipped source file the rule reads? */
export function inScope(path) {
  if (!/\.(?:m?ts|m?js)$/.test(path)) return false;
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

/** The offences in `files` ([{ path, text }]), as `path:line: why` strings. */
export function findBypasses(files) {
  const out = [];
  for (const { path, text } of files) {
    if (!inScope(path)) continue;
    const inserts = [...text.matchAll(INSERT)];
    const replays = path !== DEFINES_DUMP_ROWS && text.includes('dumpRowsInsert(');
    if (inserts.length === 0 && !replays) continue;
    const t = lex(text);
    const chains = functionChains(t);

    const guards = callsOf(t, 'refuseCondemnedAttachment');
    const claimed = new Set();
    for (const match of inserts) {
      const line = text.slice(0, match.index).split('\n').length;
      const w = stringTokenAt(t, line);
      // The nearest unclaimed guard that covers this insert.
      const g = w < 0 ? undefined : guards.filter((k) => !claimed.has(k) && covers(chains, k, w)).at(-1);
      if (g === undefined) {
        out.push(`${path}:${line}: an attachment row is written without its own refuseCondemnedAttachment() before it, in its function`);
      } else {
        claimed.add(g);
      }
    }

    if (replays) {
      const dumpGuards = callsOf(t, 'refuseCondemnedInDump');
      for (const r of callsOf(t, 'dumpRowsInsert')) {
        if (!dumpGuards.some((g) => covers(chains, g, r))) {
          out.push(`${path}:${t[r].line}: a dump load replays rows without refuseCondemnedInDump() before them, in its function`);
        }
      }
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
