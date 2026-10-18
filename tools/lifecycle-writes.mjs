/**
 * A declared lifecycle's state is written behind `assertTransition` (#2365, S6 of the review
 * checklist).
 *
 * A lifecycle (`packages/contracts/src/lifecycle.ts`, #844) says which states an entity may be
 * in and which operation moves it between them, and `assertTransition` is where an operation
 * asks it. The operation still writes the new state itself, with its own `UPDATE … SET status`,
 * which is the design: an edge names its operation and nothing more. So a raw write is not
 * wrong in itself. What is wrong is a write with no question asked first — a guard rewritten
 * inline (`if (row.status !== 'open') throw …`) beside a lifecycle that already draws the edge,
 * or no guard at all — because the declared machine and the coded one can then disagree and
 * nothing says so.
 *
 * So this reads every package that declares lifecycles in its checked-in `model.json` (held to
 * the code by `lint:model --check`): for each lifecycle, the entity's table and state field.
 * In the package's shipped source (`src/`, not tests, not `seed.ts`, not a migrations module,
 * whose backfill is no operation), the SQL inside each JS string is read for writes of the field:
 * an `UPDATE` or an upsert's `DO UPDATE` whose SET clause assigns it, and a `REPLACE INTO` whose
 * column list names it or that has none (`stateWrites` below has the forms). The SET clause is
 * read by a linear scanner, not a regex: literals and quoted names are skipped whole, parentheses
 * are counted, and only each depth-0 item's target is judged, so a state read in a value
 * (`CASE WHEN status = …`, a subquery) is not a write and no nesting before the column hides one.
 *
 * Each write must be covered by a lifecycle question: a call of `assertTransition` or
 * `transitionFor` (the one an engine uses when it keeps its own refusal reason), or of a function
 * in the same file whose body calls one directly (`requireTransition`). Covered means before the
 * write, in a block that encloses it — a guard in a sibling `if` branch does not count; or, for a
 * write inside a named helper that is the one place a state is written, every call of the helper
 * is covered the same way, or passes a guard's answer as an argument
 * (`settle(ctx, row, step(row, op))`). An INSERT is not judged: a new row's state is the
 * lifecycle's `initial`, which the compiler checks.
 *
 * **What this is, and is not.** A tripwire that reads source text. These get past it, or are
 * reported when they should not be: SQL concatenated from several strings or assembled across
 * modules, a table name interpolated, a guard asked in another file, and a JS regex literal with a
 * quote in it (read as a string). A guard also counts whichever lifecycle it names, so asking
 * about one entity covers a write of another's state in the same function (a fixture pins that
 * gap). Also, one line each:
 * - an escaped `\"` inside a double-quoted JS string reads as a quote, so a quoted identifier
 *   written that way can end the scan early;
 * - a `}` inside a string inside a template's `${…}` ends the interpolation early;
 * - a message string that reads like SQL (`'UPDATE shop_orders SET status = … failed'`) is read
 *   as SQL;
 * - a guard on the same line as the write, or an arrow function defined before it and never
 *   called, counts as cover: cover is read from token order and blocks, not from calls made.
 * Which edge an operation takes is the compiler's and the reader's. On main, and across the
 * 208 commits before it that touched a package with a lifecycle, it reports nothing.
 *
 * Exit 0: every declared state write asks first. 1: at least one does not (each printed).
 * Fixtures: `lifecycle-writes.test.mjs`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lex } from './bare-regexp.mjs';
import { blankComments, callsOf, functionChains, inScope as shippedSource, lineOf, stringTokenAt } from './attachment-writers.mjs';
import { isMainModule, repoRoot } from './repo-path.mjs';

/** Shipped source of a package: under `src/`, and not the seed or a migrations module (a backfill). */
export function inScope(path) {
  return /\/src\//.test(path) && shippedSource(path) && !/(?:^|\/)(?:seed|migrations(?:\.generated)?)\.[mc]?ts$/.test(path);
}

/** The lifecycle's own questions: `assertTransition` refuses, `transitionFor` answers (#844). */
const LIFECYCLE_CALLS = ['assertTransition', 'transitionFor'];

/**
 * Each function the tokens declare by name — `function name(` or `const name = (…) =>` — as its
 * id in `functionChains`. A head the walk back cannot read (an object-literal return type stops
 * it) leaves that function unnamed, which only ever costs a guard or a helper, never a pass.
 */
function namedFunctions(t, chains) {
  const named = [];
  for (let k = 0; k + 1 < t.length; k += 1) {
    if (t[k].text !== '{') continue;
    const inner = chains[k + 1] ?? [];
    const id = inner[inner.length - 1];
    if (id === undefined || chains[k].includes(id)) continue; // not a function opening here
    let name;
    for (let j = k - 1, parens = 0; j >= 0; j -= 1) {
      const x = t[j].text;
      if (x === ')') parens += 1;
      else if (x === '(') parens -= 1;
      else if (parens === 0 && (x === ';' || x === '{' || x === '}')) break;
      if (parens !== 0 || t[j].kind !== 'word') continue;
      // The nearest head: a statement above with no `;` (ASI) is not this function's.
      if ((x === 'function' || x === 'const' || x === 'let') && t[j + 1]?.kind === 'word') {
        name = t[j + 1].text;
        break;
      }
    }
    if (name) named.push({ id, name });
  }
  return named;
}

/** A call of `name`, not its own declaration (`function requireTransition(`). */
const callsTo = (t, name) => callsOf(t, name).filter((k) => t[k - 1]?.text !== 'function');

/**
 * The guards a file's functions are: the lifecycle's own, and every named function whose body
 * calls one directly (`requireTransition(row, op)` wrapping `assertTransition`). One level only:
 * an operation that calls such a wrapper and then writes is a writer, not a guard, and taking it
 * for one would cover whatever its callers write.
 */
function guardsOf(t, chains, named) {
  const direct = LIFECYCLE_CALLS.flatMap((n) => callsTo(t, n));
  const names = new Set(LIFECYCLE_CALLS);
  for (const { id, name } of named) if (direct.some((g) => chains[g].includes(id))) names.add(name);
  return names;
}

/** `guardsOf` for a source text, for the fixtures. */
export function guardNames(text) {
  const t = lex(blankComments(text));
  const chains = functionChains(t);
  return guardsOf(t, chains, namedFunctions(t, chains));
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The declared `{ entity, table, field }` of each lifecycle in a model.json. */
export function lifecyclesOf(model) {
  return Object.entries(model.lifecycles ?? {}).flatMap(([entity, l]) => {
    const table = model.entities?.[entity]?.table;
    return table && l.field ? [{ entity, table, field: l.field }] : [];
  });
}

/**
 * Every JS string in a comment-blanked source, as `{ at, body }`: `at` is the offset of the body's
 * first character, and `body` is the text between the quotes with each escape's backslash and each
 * `${…}` interpolation blanked to spaces (an interpolation leaves a `?` in its place), so offsets
 * in the body are offsets in the source. SQL is read only inside one string: a statement assembled
 * by concatenating strings is not seen.
 */
export function jsStrings(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const q = text[i];
    if (q !== "'" && q !== '"' && q !== '\x60') {
      i += 1;
      continue;
    }
    const at = i + 1;
    let body = '';
    let j = at;
    for (; j < text.length && text[j] !== q; j += 1) {
      if (q !== '\x60' && text[j] === '\n') break; // an unterminated quote: not a string
      if (text[j] === '\\') {
        body += ' ' + (text[j + 1] ?? '');
        j += 1;
      } else if (q === '\x60' && text[j] === '$' && text[j + 1] === '{') {
        let depth = 0;
        let k = j + 1;
        for (; k < text.length; k += 1) {
          if (text[k] === '{') depth += 1;
          else if (text[k] === '}' && (depth -= 1) === 0) break;
        }
        body += '?' + ' '.repeat(k - j);
        j = k;
      } else body += text[j];
    }
    out.push({ at, body });
    i = j + 1;
  }
  return out;
}

const WORD = /[A-Za-z0-9_$]/;

/** The identifier at `i` (bare, or quoted with `"`, `[]` or a backtick), unquoted, and where it ends. */
function identAt(sql, i) {
  const close = { '"': '"', '[': ']', '\x60': '\x60' }[sql[i]];
  if (close) {
    const end = sql.indexOf(close, i + 1);
    return end < 0 ? null : { name: sql.slice(i + 1, end), end: end + 1 };
  }
  let end = i;
  while (end < sql.length && WORD.test(sql[end])) end += 1;
  return end === i ? null : { name: sql.slice(i, end), end };
}

/** Past a SQL comment at `i` (`-- …` to the line's end, `/* … *\/`), or `i` when none starts there. */
function pastComment(sql, i) {
  if (sql[i] === '-' && sql[i + 1] === '-') {
    const end = sql.indexOf('\n', i);
    return end < 0 ? sql.length : end + 1;
  }
  if (sql[i] === '/' && sql[i + 1] === '*') {
    const end = sql.indexOf('*/', i + 2);
    return end < 0 ? sql.length : end + 2;
  }
  return i;
}

/** Past whitespace and SQL comments. */
const skipSpace = (sql, i) => {
  for (;;) {
    while (i < sql.length && /\s/.test(sql[i])) i += 1;
    const next = pastComment(sql, i);
    if (next === i) return i;
    i = next;
  }
};

/** Past a SQL string literal opening at `i` (`''` is an escaped quote). */
function pastLiteral(sql, i) {
  for (let j = i + 1; j < sql.length; j += 1) {
    if (sql[j] !== "'") continue;
    if (sql[j + 1] === "'") j += 1;
    else return j + 1;
  }
  return sql.length;
}

/** The names in a parenthesised list opening at `i` (a column list, a row value), and where it ends. */
function namesIn(sql, i) {
  const names = [];
  let depth = 0;
  let j = i;
  while (j < sql.length) {
    const c = sql[j];
    if (pastComment(sql, j) !== j) j = pastComment(sql, j);
    else if (c === "'") j = pastLiteral(sql, j);
    else if (c === '(') (depth += 1), (j += 1);
    else if (c === ')') {
      j += 1;
      if ((depth -= 1) === 0) break;
    } else if (depth === 1 && (c === '"' || c === '[' || c === '\x60' || WORD.test(c))) {
      const id = identAt(sql, j);
      if (!id) break;
      names.push(id.name);
      j = id.end;
    } else j += 1;
  }
  return { names, end: j };
}

const STOP = new Set(['where', 'returning', 'from']);

/**
 * Does the SET clause starting at `i` assign `field`? A linear scan: string literals, SQL comments
 * and quoted identifiers are skipped whole, parentheses are counted, the clause is split into items at
 * depth-0 commas and ends at a depth-0 WHERE, RETURNING, FROM or `;` (or at an unmatched `)`).
 * Only each item's TARGET is judged — `<field> =`, or `(…, <field>, …) =` — so the state read in a
 * value (`CASE WHEN status = …`, a subquery) is not a write.
 */
export function setAssigns(sql, i, field) {
  const want = field.toLowerCase();
  let depth = 0;
  let item = true;
  while (i < sql.length) {
    i = skipSpace(sql, i);
    if (i >= sql.length) break;
    if (item && depth === 0) {
      item = false;
      if (sql[i] === '(') {
        const list = namesIn(sql, i);
        const eq = skipSpace(sql, list.end);
        if (sql[eq] === '=' && list.names.some((n) => n.toLowerCase() === want)) return true;
        i = list.end;
        continue;
      }
      const id = identAt(sql, i);
      if (id) {
        if (STOP.has(id.name.toLowerCase())) return false;
        const eq = skipSpace(sql, id.end);
        if (sql[eq] === '=' && sql[eq + 1] !== '=' && id.name.toLowerCase() === want) return true;
        i = id.end;
        continue;
      }
    }
    const c = sql[i];
    if (c === "'") i = pastLiteral(sql, i);
    else if (pastComment(sql, i) !== i) i = pastComment(sql, i);
    else if (c === '"' || c === '[' || c === '\x60') i = identAt(sql, i)?.end ?? i + 1;
    else if (c === '(') (depth += 1), (i += 1);
    else if (c === ')') {
      if ((depth -= 1) < 0) return false;
      i += 1;
    } else if (depth === 0 && c === ',') (item = true), (i += 1);
    else if (depth === 0 && c === ';') return false;
    else if (WORD.test(c)) {
      let end = i;
      while (end < sql.length && WORD.test(sql[end])) end += 1;
      if (depth === 0 && STOP.has(sql.slice(i, end).toLowerCase())) return false;
      i = end;
    } else i += 1;
  }
  return false;
}

/** One identifier as SQLite reads it: bare, or quoted with `"`, `[]` or a backtick. */
const IDENT = String.raw`(?:"[^"\n]+"|\[[^\]\n]+\]|\x60[^\x60\n]+\x60|\w+)`;

/**
 * The offsets in `sql` of each statement that writes `field` of `table`:
 * - `UPDATE [OR …] [schema.]<table> … SET …` whose SET clause assigns it (`setAssigns`);
 * - an upsert, `INSERT [OR …] INTO [schema.]<table> … DO UPDATE SET …`, the same way;
 * - `REPLACE INTO` / `INSERT OR REPLACE INTO <table>` whose column list names it, or that has no
 *   column list (`… SELECT`, `… VALUES`), which replaces every column.
 * The heads are matched by regex with no nested quantifier; everything after them is the scan.
 */
export function stateWrites(sql, table, field) {
  const t = escape(table);
  const target = String.raw`(?:${IDENT}\s*\.\s*)?(?:"${t}"|\[${t}\]|\x60${t}\x60|${t}\b)`;
  const out = [];
  for (const m of sql.matchAll(new RegExp(String.raw`\bUPDATE\s+(?:OR\s+\w+\s+)?${target}(?:\s+AS\s+\w+)?\s+SET\b`, 'gi'))) {
    if (setAssigns(sql, m.index + m[0].length, field)) out.push(m.index);
  }
  for (const m of sql.matchAll(new RegExp(String.raw`\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+${target}`, 'gi'))) {
    const rest = sql.slice(m.index + m[0].length);
    const end = rest.search(/;|\bINSERT\b|\bUPDATE\s+(?!SET)/i);
    const doUpdate = /\bDO\s+UPDATE\s+SET\b/i.exec(end < 0 ? rest : rest.slice(0, end));
    if (doUpdate && setAssigns(sql, m.index + m[0].length + doUpdate.index + doUpdate[0].length, field)) out.push(m.index);
  }
  for (const m of sql.matchAll(new RegExp(String.raw`\bREPLACE\s+INTO\s+${target}`, 'gi'))) {
    const at = skipSpace(sql, m.index + m[0].length);
    const named = sql[at] === '(' ? namesIn(sql, at).names : null;
    if (!named || named.some((n) => n.toLowerCase() === field.toLowerCase())) out.push(m.index);
  }
  return [...new Set(out)].sort((x, y) => x - y);
}

/** Each token's chain of enclosing blocks (`{`…`}`), innermost last, as ids. */
function blockChains(t) {
  const chains = new Array(t.length);
  const stack = [];
  let next = 1;
  for (let k = 0; k < t.length; k += 1) {
    if (t[k].text === '}' && t[k].kind === 'punct') stack.pop();
    chains[k] = [...stack];
    if (t[k].text === '{' && t[k].kind === 'punct') stack.push(next++);
  }
  return chains;
}

/** A guard at `g` covers `k`: before it, and in a block that encloses it (never a sibling branch). */
const blockCovers = (blocks, g, k) => {
  if (g >= k) return false;
  const inner = blocks[g][blocks[g].length - 1];
  return inner === undefined || blocks[k].includes(inner);
};

/**
 * Writes of a declared state with no lifecycle question before them. Covered means a guard call
 * before the write, in a block that encloses it (a guard in a sibling `if` branch does not count)
 * — or, for a write inside a named helper (`moveTo(ctx, row, next)`, the one place a state is
 * written), every call of that helper in the file is itself covered, or passes a guard's answer
 * as an argument, to a depth of three helpers. A helper nothing calls is not covered.
 */
export function unguardedWrites(files, lifecycles) {
  const out = [];
  for (const { path, text: source } of files) {
    if (!inScope(path)) continue;
    const text = blankComments(source);
    let c;
    for (const { at, body } of jsStrings(text)) {
      for (const { entity, table, field } of lifecycles) {
        for (const offset of stateWrites(body, table, field)) {
          if (!c) {
            const t = lex(text);
            const chains = functionChains(t);
            const named = namedFunctions(t, chains);
            c = { t, chains, blocks: blockChains(t), named, guards: [...guardsOf(t, chains, named)].flatMap((n) => callsTo(t, n)) };
          }
          const line = lineOf(text, at + offset);
          const w = stringTokenAt(c.t, line);
          if (w >= 0 && coveredAt(c, w, 3)) continue;
          out.push({ path, line, entity, field });
        }
      }
    }
  }
  return out;
}

/** Is token `k` covered by a guard, directly or through every call of the helper it sits in? */
function coveredAt(c, k, depth) {
  if (c.guards.some((g) => blockCovers(c.blocks, g, k))) return true;
  if (depth === 0) return false;
  const around = c.chains[k];
  const helper = c.named.filter((f) => around.includes(f.id)).sort((x, y) => around.indexOf(y.id) - around.indexOf(x.id))[0];
  if (!helper) return false;
  const sites = callsTo(c.t, helper.name).filter((s) => !c.chains[s].includes(helper.id));
  return sites.length > 0 && sites.every((s) => guardInArguments(c, s) || coveredAt(c, s, depth - 1));
}

/** Is a guard called inside the argument list of the call at `s`? Arguments run before the call. */
function guardInArguments(c, s) {
  let depth = 0;
  let close = s + 1;
  for (; close < c.t.length; close += 1) {
    if (c.t[close].text === '(') depth += 1;
    else if (c.t[close].text === ')' && (depth -= 1) === 0) break;
  }
  return c.guards.some((g) => g > s + 1 && g < close);
}

function main() {
  const root = repoRoot(import.meta.url);
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const models = git(['ls-files', '--', 'demos/*/model.json', 'engines/*/model.json', 'apps/*/model.json']).split('\n').filter(Boolean);
  const hits = [];
  let declared = 0;
  for (const modelPath of models) {
    const lifecycles = lifecyclesOf(JSON.parse(readFileSync(join(root, modelPath), 'utf8')));
    if (lifecycles.length === 0) continue;
    declared += lifecycles.length;
    const pkg = modelPath.slice(0, -'/model.json'.length);
    const files = git(['ls-files', '--', `${pkg}/src`]).split('\n').filter(Boolean).map((path) => ({ path, text: readFileSync(join(root, path), 'utf8') }));
    hits.push(...unguardedWrites(files, lifecycles));
  }
  if (hits.length > 0) {
    console.error(`lifecycle-writes: ${hits.length} write(s) of a declared lifecycle state with no lifecycle question before them:\n`);
    for (const h of hits) console.error(`  ${h.path}:${h.line}: ${h.entity}.${h.field}`);
    console.error(
      '\nAsk the declaration before writing: assertTransition(lifecycle, label, from, operation) — or\n' +
        'transitionFor() where the engine keeps its own refusal — in the function that writes, or in\n' +
        'every caller of the helper that does. apps/docs/concepts/lifecycle.md has the shapes.',
    );
    process.exit(1);
  }
  console.log(`lifecycle-writes: ${declared} declared lifecycle(s); every state write asks the lifecycle first.`);
}

if (isMainModule(import.meta.url)) main();
