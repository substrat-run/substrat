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
 * whose backfill is no operation), every write of the field — an `UPDATE` or an upsert's
 * `DO UPDATE` whose SET list names it, or a `REPLACE INTO` whose column list does (`stateWrite`
 * below has the forms) — must be covered by a
 * lifecycle question: a call of `assertTransition` or `transitionFor` (the one an engine uses when
 * it keeps its own refusal reason), or of a function in the same file whose body calls one
 * directly (`requireTransition`). Covered means before the write, in its function or one
 * enclosing it (the function reading of `attachment-writers.mjs`); or, for a write inside a
 * named helper that is the one place a state is written, every call of the helper is covered
 * the same way, or passes a guard's answer as an argument (`settle(ctx, row, step(row, op))`).
 * An INSERT is not judged: a new row's state is the lifecycle's `initial`, which the compiler
 * checks.
 *
 * **What this is, and is not.** A tripwire that reads text: SQL assembled across modules, a
 * table name interpolated, or a guard asked in another file gets past it, or is reported when it
 * should not be. A `;` inside a SQL string literal ends a SET list early (reading past it would let
 * the match leave the SQL and run into the code after it), so a state column after one is not seen.
 * A guard also counts whichever lifecycle it names, so asking about one entity
 * covers a write of another's state in the same function (a fixture pins that gap). Which edge an
 * operation takes is the compiler's and the reader's. On main and
 * across the 208 commits before it that touched a package with a lifecycle, it reports nothing.
 *
 * Exit 0: every declared state write asks first. 1: at least one does not (each printed).
 * Fixtures: `lifecycle-writes.test.mjs`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lex } from './bare-regexp.mjs';
import { blankComments, callsOf, covers, functionChains, inScope as shippedSource, lineOf, stringTokenAt } from './attachment-writers.mjs';
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

/** One identifier as SQLite reads it: bare, or quoted with `"`, `[]` or a backtick. */
const IDENT = String.raw`(?:"[^"\n]+"|\[[^\]\n]+\]|\x60[^\x60\n]+\x60|\w+)`;

/**
 * A statement that writes `field` of `table`:
 * - `UPDATE [OR …] [schema.]<table> … SET …` naming the field, as `<field> =` or inside a row-value
 *   list, `(a, <field>) =`;
 * - an upsert, `INSERT [OR …] INTO [schema.]<table> … ON CONFLICT … DO UPDATE SET …`, the same way;
 * - `REPLACE INTO` / `INSERT OR REPLACE INTO <table> (…, <field>, …)`, which replaces a row's state.
 * Table and field may each be quoted. The SET list ends at WHERE or RETURNING, so a state named in
 * the condition is a read; a quote does not end it, so a literal before the column
 * (`SET note = 'x', status = ?`) does not hide the write.
 */
export function stateWrite(table, field) {
  const t = escape(table);
  const fl = escape(field);
  const target = String.raw`(?:${IDENT}\s*\.\s*)?(?:"${t}"|\[${t}\]|\x60${t}\x60|${t}\b)`;
  const col = String.raw`(?:"${fl}"|\[${fl}\]|\x60${fl}\x60|\b${fl}\b)`;
  // A parenthesised group (a subquery, a call), two levels deep, is read whole, so its WHERE does
  // not end the list; anything else ends at WHERE, RETURNING or `;`.
  const group = String.raw`\((?:[^();\x60]|\([^();\x60]*\))*\)`;
  const rowValue = String.raw`\((?:[^()=;\x60]*,\s*)?${col}(?:\s*,[^()=;\x60]*)?\)\s*=`;
  const set = String.raw`SET\b(?:${group}|(?!\b(?:WHERE|RETURNING)\b)[^;\x60()])*?(?:${col}\s*=|${rowValue})`;
  const update = String.raw`\bUPDATE\s+(?:OR\s+\w+\s+)?${target}(?:\s+AS\s+\w+)?\s+${set}`;
  const upsert = String.raw`\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+${target}[^;\x60]*?\bDO\s+UPDATE\s+${set}`;
  const replace = String.raw`\bREPLACE\s+INTO\s+${target}\s*\([^)]*?${col}`;
  return new RegExp(`${update}|${upsert}|${replace}`, 'gi');
}

/**
 * Writes of a declared state with no lifecycle question before them. Covered means a guard call
 * before the write, in its function or one enclosing it — or, for a write inside a named helper
 * (`moveTo(ctx, row, next)`, the one place a state is written), every call of that helper in the
 * file is itself covered, or passes a guard's answer as an argument, to a depth of three helpers.
 * A helper nothing calls is not covered.
 */
export function unguardedWrites(files, lifecycles) {
  const writes = lifecycles.map((l) => ({ ...l, re: stateWrite(l.table, l.field) }));
  const out = [];
  for (const { path, text: source } of files) {
    if (!inScope(path)) continue;
    const text = blankComments(source);
    let c;
    for (const { entity, field, re } of writes) {
      for (const m of text.matchAll(re)) {
        if (!c) {
          const t = lex(text);
          const chains = functionChains(t);
          const named = namedFunctions(t, chains);
          c = { t, chains, named, guards: [...guardsOf(t, chains, named)].flatMap((n) => callsTo(t, n)) };
        }
        const line = lineOf(text, m.index);
        const w = stringTokenAt(c.t, line);
        if (w >= 0 && coveredAt(c, w, 3)) continue;
        out.push({ path, line, entity, field });
      }
    }
  }
  return out;
}

/** Is token `k` covered by a guard, directly or through every call of the helper it sits in? */
function coveredAt(c, k, depth) {
  if (c.guards.some((g) => covers(c.chains, g, k))) return true;
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
