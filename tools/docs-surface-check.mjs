#!/usr/bin/env node
/**
 * The engine-surface checkpoint (#988).
 *
 * `apps/docs/engines/<name>/surface.md` is the published description of an
 * engine's two surfaces: its operations, and the in-scope functions a vertical
 * composes. It is a second description of `engines/<name>/src`, and second
 * descriptions rot — silently, because nothing fails when they do. `#811` made
 * `listOrders` paged and the page kept documenting `listOrders(ctx, status?)`
 * for weeks; booking grew three paged twins that the page named nowhere.
 *
 * `lint:docs:drift` measures *how much source moved* since a page last did, and
 * `lint:llms` checks the sidebar links. Neither compares a documented name to a
 * real export, which is the drift a reader actually copies into their editor.
 *
 * This gate **refuses, it does not emit**. Emitting the table from
 * `operations.ts` was the other option and it is the wrong one here: the tables
 * carry a *Does* / *Notes* column that is prose a person writes, and a
 * generator would either drop it or invent it. So the page stays hand-written
 * and the names in it are checked, both directions:
 *
 *   1. **Nothing documented is imaginary.** Every `name(` in a table row or a
 *      ```ts fence under "In-scope functions", and every `<engine>/<op>` key in
 *      a backtick anywhere on the page, names something the engine really
 *      exports or really registers.
 *   2. **Nothing exported is unmentioned.** Every exported function whose first
 *      parameter is `ctx` — the in-scope surface, by definition — and every
 *      declared operation key is named somewhere on the page.
 *
 * It is deliberately **name-level only**. Checking that a documented signature
 * matches the compiled one needs the type checker, which this does not carry; a
 * name is what a reader types first and the cheap half catches the two failures
 * the issue was filed for.
 *
 *   node tools/docs-surface-check.mjs            # report, exit 0
 *   node tools/docs-surface-check.mjs --check    # CI: exit 1 on drift
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.slice(2).includes('--check');

const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// ---------------------------------------------------------------------------
// What the source says
// ---------------------------------------------------------------------------

/**
 * The declaration forms an exported function can take, each capturing
 * `(name, firstParameter)`. A false negative here is the expensive kind — the
 * function silently stops being checked and the page may omit it — so every
 * form the codebase could plausibly grow is matched, generics included, not
 * just the one the seven engines happen to use today.
 */
const CTX_FIRST = [
  // export function f(ctx, …) · export async function f<T>(ctx, …)
  /^export\s+(?:async\s+)?function\s+(\w+)\s*(?:<[^<>(]*>)?\s*\(\s*([\w$]*)/gm,
  // export const f = (ctx, …) => … · = async (ctx, …) => … · = function (ctx, …)
  /^export\s+const\s+(\w+)\s*(?::[^=\n]*)?=\s*(?:async\s+)?(?:function\s*\w*\s*)?(?:<[^<>(]*>\s*)?\(\s*([\w$]*)/gm,
];

/**
 * Every name `src/index.ts` exports, plus the subset that is an in-scope
 * function. "In-scope function" is not a list we keep: it is `export function
 * f(ctx, …)`, which is precisely the shape a vertical composes inside its own
 * operation. A re-export block is followed one hop into the local file it names
 * so an engine that keeps its lifecycle in `lifecycle.ts` reads the same.
 */
function exportsOf(engineDir) {
  /** Names the package's entry point really hands out. */
  const all = new Set();
  /** Every `function f(ctx, …)` declared anywhere under `src/`, public or not. */
  const ctxFns = new Set();
  const seen = new Set();

  /**
   * `starred` distinguishes the two ways a local file's declarations become
   * public. Under `export * from './x.js'` they all are; under `export { a } from
   * './x.js'` only the named ones are, and the file is read purely to learn
   * whether `a` takes `ctx` — so its other declarations must not leak into `all`.
   */
  const visit = (rel, starred) => {
    const key = `${rel}:${starred}`;
    if (seen.has(key) || !rel || !existsSync(join(ROOT, rel))) return;
    seen.add(key);
    const src = read(rel);

    for (const re of CTX_FIRST) {
      for (const m of src.matchAll(re)) {
        if (starred) all.add(m[1]);
        if (m[2] === 'ctx') ctxFns.add(m[1]);
      }
    }
    if (starred) {
      for (const m of src.matchAll(/^export\s+(?:const|let|class|type|interface|enum)\s+(\w+)/gm)) {
        all.add(m[1]);
      }
    }

    // `export { a, b as c } from './x.js'`, single- or multi-line, plus `export * from`.
    for (const m of src.matchAll(/^export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gm)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop()?.replace(/^type\s+/, '').trim();
        if (name) all.add(name);
      }
      visit(localFile(rel, m[2]), false);
    }
    for (const m of src.matchAll(/^export\s*\*\s*from\s*['"](\.[^'"]+)['"]/gm)) {
      visit(localFile(rel, m[1]), true);
    }
  };

  visit(`${engineDir}/src/index.ts`, true);
  // In-scope = takes `ctx` AND is actually reachable from the entry point.
  return { all, inScope: new Set([...ctxFns].filter((n) => all.has(n))) };
}

/** `'./lifecycle.js'` beside `engines/x/src/index.ts` → `engines/x/src/lifecycle.ts`. */
function localFile(fromRel, spec) {
  if (!spec.startsWith('.')) return '';
  return join(dirname(fromRel), spec.replace(/\.js$/, '.ts'));
}

/** The operation keys the engine registers, read from its `operations.ts`. */
function operationKeys(engineDir, engine) {
  const rel = `${engineDir}/src/operations.ts`;
  if (!existsSync(join(ROOT, rel))) return new Set();
  const src = read(rel);
  const keys = new Set();
  for (const m of src.matchAll(/['"]([a-z0-9-]+\/[a-z0-9-]+)['"]\s*:/gi)) {
    if (m[1].startsWith(`${engine}/`)) keys.add(m[1]);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// What the page says
// ---------------------------------------------------------------------------

/** The lines of the `## In-scope functions` section, up to the next `## `. */
function inScopeSection(page) {
  const lines = page.split('\n');
  const start = lines.findIndex((l) => /^##\s+In-scope functions/i.test(l));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s/.test(l));
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * The function names the section *claims*, from the two places a claim is made:
 * a table row's cells, and a fenced `ts` block. Inline backticks in prose are
 * deliberately excluded — invoicing's page names `exportUnderlag(ctx, …)` in a
 * sentence explaining why it does **not** exist, and a checker that read prose
 * as a claim would call that page wrong for being right.
 */
function documentedFunctions(lines) {
  const names = new Set();
  let fence = null;

  for (const line of lines) {
    const open = line.match(/^\s*```(\w*)/);
    if (open) {
      fence = fence === null ? open[1] : null;
      continue;
    }

    if (fence !== null) {
      if (fence !== 'ts' && fence !== 'typescript') continue;
      // A call at the head of a line: `holdReservation(ctx, { … })  → Reservation`.
      const call = line.match(/^\s*(?:(?:const|let|await)\s+)?([a-z]\w*)\s*\(/);
      if (call) names.add(call[1]);
      // The `a · b · c` shorthand booking uses for a run of sibling transitions.
      if (/^\s*[a-z]\w*(\s+·\s+[a-z]\w*)+\s*$/.test(line)) {
        for (const n of line.split('·')) names.add(n.trim());
      }
      continue;
    }

    if (!/^\s*\|/.test(line) || /^\s*\|[\s|:-]*\|?\s*$/.test(line)) continue;
    for (const cell of line.split('|')) {
      const m = cell.trim().match(/^`([a-z]\w*)\(/);
      if (m) names.add(m[1]);
    }
  }
  return names;
}

/**
 * The operation keys the page *claims*, from table rows only — the same reason
 * `documentedFunctions` ignores prose. The work-order page spends a whole tip
 * block on why `workorder/create` deliberately does **not** exist, and a checker
 * that read prose as a claim would call that page wrong for being right.
 */
function documentedOperations(page, engine) {
  const keys = new Set();
  for (const line of page.split('\n')) {
    if (!/^\s*\|/.test(line)) continue;
    for (const m of line.matchAll(/`([a-z0-9-]+\/[a-z0-9-]+)`/gi)) {
      if (m[1].startsWith(`${engine}/`)) keys.add(m[1]);
    }
  }
  return keys;
}

/** Loose: a name is "mentioned" if it appears on the page as a whole word. */
const mentions = (page, name) => new RegExp(`(?<![\\w/-])${name}(?![\\w-])`).test(page);

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

const engines = readdirSync(join(ROOT, 'engines'), { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(ROOT, 'engines', e.name, 'package.json')))
  .map((e) => e.name)
  .filter((name) => !JSON.parse(read(`engines/${name}/package.json`)).private)
  .sort();

/** @type {{engine: string, kind: string, detail: string}[]} */
const problems = [];
/** @type {{engine: string, documented: number, inScope: number, ops: number}[]} */
const coverage = [];

for (const engine of engines) {
  const pageRel = `apps/docs/engines/${engine}/surface.md`;
  if (!existsSync(join(ROOT, pageRel))) {
    // A published engine with no surface page is `lint:docs:drift`'s failure to
    // report, not this one's — it checks the page exists at all.
    continue;
  }

  const page = read(pageRel);
  const { all, inScope } = exportsOf(`engines/${engine}`);
  const ops = operationKeys(`engines/${engine}`, engine);

  const section = inScopeSection(page);
  if (section === null) {
    problems.push({
      engine,
      kind: 'no-section',
      detail: `${pageRel} has no "## In-scope functions" heading, so nothing on it is checked.`,
    });
    continue;
  }

  const documented = documentedFunctions(section);
  coverage.push({ engine, documented: documented.size, inScope: inScope.size, ops: ops.size });

  for (const name of [...documented].sort()) {
    if (!all.has(name)) {
      problems.push({
        engine,
        kind: 'phantom-function',
        detail: `${pageRel} documents \`${name}(…)\`, which engines/${engine}/src exports nothing by that name.`,
      });
    }
  }

  for (const key of [...documentedOperations(page, engine)].sort()) {
    if (!ops.has(key)) {
      problems.push({
        engine,
        kind: 'phantom-operation',
        detail: `${pageRel} names the operation \`${key}\`, which engines/${engine}/src/operations.ts does not register.`,
      });
    }
  }

  for (const name of [...inScope].sort()) {
    if (!mentions(page, name)) {
      problems.push({
        engine,
        kind: 'undocumented-function',
        detail: `engines/${engine}/src exports the in-scope function \`${name}(ctx, …)\`, which ${pageRel} never names.`,
      });
    }
  }

  for (const key of [...ops].sort()) {
    // The suffix alone counts: booking's page writes a run of sibling
    // transitions as `booking/start` · `complete` · `no-show`, which names all
    // three to a reader and only one to a regex.
    const suffix = key.slice(engine.length + 1);
    if (!mentions(page, key) && !page.includes(`\`${suffix}\``)) {
      problems.push({
        engine,
        kind: 'undocumented-operation',
        detail: `engines/${engine}/src/operations.ts registers \`${key}\`, which ${pageRel} never names.`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log('\nengine        documented  in-scope  operations');
console.log('-'.repeat(44));
for (const c of coverage) {
  console.log(
    `${c.engine.padEnd(12)}  ${String(c.documented).padStart(10)}  ${String(c.inScope).padStart(8)}  ${String(c.ops).padStart(10)}`,
  );
}
console.log(`\ndocs-surface: ${coverage.length} engine surface page(s) checked against their exports`);

if (!problems.length) {
  console.log('docs-surface: ok');
  process.exit(0);
}

const byEngine = new Map();
for (const p of problems) byEngine.set(p.engine, [...(byEngine.get(p.engine) ?? []), p]);
for (const [engine, list] of byEngine) {
  console.log(`\n${engine}:`);
  for (const p of list) console.log(`  ${p.detail}`);
}

console.log(`\n${problems.length} problem(s).`);

if (!CHECK) {
  console.log('(advisory — run with --check for the CI exit code)');
  process.exit(0);
}

console.error(
  '\ndocs-surface: FAILED\n' +
    '  A name on a published surface page is what a reader types into their editor first.\n' +
    '  A documented function the engine does not export sends them to a call that will not\n' +
    '  compile; an exported one the page never names is a surface nobody can find. Fix the\n' +
    '  page against the source — or, if the export really went away, that is a non-additive\n' +
    '  engine change and the page is telling you so.',
);
process.exit(1);
