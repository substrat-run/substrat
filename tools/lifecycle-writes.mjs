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
 * whose backfill is no operation), every `UPDATE <table> … SET … <field> =` must be covered by a
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
 * should not be. Which edge an operation takes is the compiler's and the reader's. On main and
 * across the 208 commits before it that touched a package with a lifecycle, it reports nothing.
 *
 * Exit 0: every declared state write asks first. 1: at least one does not (each printed).
 * Fixtures: `lifecycle-writes.test.mjs`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { lex } from './bare-regexp.mjs';
import { blankComments, callsOf, covers, functionChains, lineOf, stringTokenAt } from './attachment-writers.mjs';

/** Shipped source of a package: under `src/`, not a test, not the seed. */
export function inScope(path) {
  if (!/\/src\//.test(path) || !/\.(?:ts|tsx|mts|js|mjs)$/.test(path) || /\.d\.[mc]?ts$/.test(path)) return false;
  if (/(?:^|\/)migrations(?:\.generated)?\.[mc]?ts$/.test(path)) return false; // a backfill, not an operation
  return !/(?:^|\/)(?:test|tests|__tests__)\//.test(path) && !/\.(?:test|spec)\.[mc]?[jt]sx?$/.test(path) && !/(?:^|\/)seed\.[mc]?ts$/.test(path);
}

/** The lifecycle's own questions: `assertTransition` refuses, `transitionFor` answers (#844). */
const LIFECYCLE_CALLS = ['assertTransition', 'transitionFor'];

/**
 * The guards a file can call: the lifecycle's own, and every function the file declares whose body
 * calls one directly (`requireTransition(row, op)` wrapping `assertTransition`). One level only:
 * an operation that calls such a wrapper and then writes is a writer, not a guard, and taking it
 * for one would cover whatever its callers write.
 */
/** Each function the file declares by name, with its body's range in `text`. */
export function namedFunctions(text) {
  const bodies = [];
  for (const m of text.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*[(<]|\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/g)) {
    const open = text.indexOf('{', m.index + m[0].length - 1);
    if (open < 0) continue;
    let depth = 0;
    let end = open;
    for (; end < text.length; end += 1) {
      if (text[end] === '{') depth += 1;
      else if (text[end] === '}' && (depth -= 1) === 0) break;
    }
    bodies.push({ name: m[1] ?? m[2], start: open, end, body: text.slice(open, end) });
  }
  return bodies;
}

export function guardNames(text) {
  const names = new Set(LIFECYCLE_CALLS);
  for (const { name, body } of namedFunctions(text)) {
    if (LIFECYCLE_CALLS.some((n) => new RegExp(`\\b${n}\\s*\\(`).test(body))) names.add(name);
  }
  return names;
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
 * Writes of a declared state with no lifecycle question before them. Covered means a guard call
 * before the write, in its function or one enclosing it — or, for a write inside a named helper
 * (`moveTo(ctx, row, next)`, the one place a state is written), every call of that helper in the
 * file is itself covered, to a depth of three helpers. A helper nothing calls is not covered.
 */
export function unguardedWrites(files, lifecycles) {
  const out = [];
  for (const { path, text: source } of files) {
    if (!inScope(path)) continue;
    const text = blankComments(source);
    let ctx;
    const context = () => {
      if (ctx) return ctx;
      const t = lex(text);
      const chains = functionChains(t);
      // A call, not the guard's own declaration (`function requireTransition(`), which sits
      // outside every body and would otherwise cover the whole file.
      const calls = (name) => callsOf(t, name).filter((k) => t[k - 1]?.text !== 'function');
      const guards = [...guardNames(text)].flatMap(calls);
      const named = namedFunctions(text);
      const starts = lineStarts(text);
      const offsetOf = (k) => starts[t[k].line - 1];
      return (ctx = { t, chains, calls, guards, named, offsetOf });
    };
    for (const { entity, table, field } of lifecycles) {
      // `UPDATE <table>` (quoted or not), then the SET list up to its end, naming the field.
      const re = new RegExp(String.raw`\bUPDATE\s+["\x60\[]?${escape(table)}["\x60\]]?(?:\s+AS\s+\w+)?\s+SET\b[^;'"\x60]*?\b${escape(field)}\s*=`, 'gi');
      for (const m of text.matchAll(re)) {
        const c = context();
        const line = lineOf(text, m.index);
        const w = stringTokenAt(c.t, line);
        if (w >= 0 && coveredAt(c, w, m.index, 3)) continue;
        out.push({ path, line, entity, field });
      }
    }
  }
  return out;
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

/** Is token `k` (at character `at`) covered by a guard, directly or through every caller? */
function coveredAt(c, k, at, depth) {
  if (c.guards.some((g) => covers(c.chains, g, k))) return true;
  if (depth === 0) return false;
  // The innermost named function around the write, and every call of it.
  const helper = c.named.filter((f) => f.start < at && at < f.end).sort((a, b) => b.start - a.start)[0];
  if (!helper) return false;
  const sites = c.calls(helper.name).filter((s) => !(helper.start < c.offsetOf(s) && c.offsetOf(s) < helper.end));
  return sites.length > 0 && sites.every((s) => guardInArguments(c, s) || coveredAt(c, s, c.offsetOf(s), depth - 1));
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
  const root = fileURLToPath(new URL('..', import.meta.url));
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const models = git(['ls-files', '--', 'demos/*/model.json', 'engines/*/model.json', 'apps/*/model.json']).split('\n').filter(Boolean);
  const hits = [];
  let declared = 0;
  for (const modelPath of models) {
    const lifecycles = lifecyclesOf(JSON.parse(readFileSync(`${root}${modelPath}`, 'utf8')));
    if (lifecycles.length === 0) continue;
    declared += lifecycles.length;
    const pkg = modelPath.slice(0, -'/model.json'.length);
    const files = git(['ls-files', '--', `${pkg}/src`]).split('\n').filter(Boolean).map((path) => ({ path, text: readFileSync(`${root}${path}`, 'utf8') }));
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
