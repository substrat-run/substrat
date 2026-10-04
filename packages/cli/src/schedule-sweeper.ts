/**
 * Who runs a vertical's declared schedules on a hosted deploy (#1646, #1902).
 *
 * The only platform timer is the control plane's cron, and it iterates the schedules of the
 * control plane's OWN host, which registers no modules. A pushed, control-plane-less vertical
 * needs a timer of its own (`docs/architecture/scheduler.md` §3.3): a `defineScopeSweeperDO`
 * singleton, exported from the worker entry and bound as a Durable Object class, whose roster
 * the platform fills through `/internal/provision` → `noteScope`.
 *
 * Since #1902 the platform supplies that sweeper at upload to a vertical that brings none, so a
 * vertical either wires its own or wires nothing. Three shapes are still wrong, and this file
 * names them (`sweeperOffence`):
 *
 *   1. an OWN sweeper nothing binds. workerd resolves a Durable Object class from the entry's
 *      exports and instantiates only a bound one, so its alarm never runs (Copilot review on
 *      #1873 found the unexported-const variant);
 *   2. no own sweeper, but the platform's names — class `SweeperDO`, binding `SWEEPER` — used
 *      for something else, which the control plane refuses at push;
 *   3. no own sweeper, and a `@substrat-run/vertical-host` too old to register the host the
 *      platform's sweeper runs.
 *
 * Two callers share this file, and that is why it lives in a published package:
 *
 *   - `substrat push` (`assertSchedulesAreSwept` in `push.ts`), the only check an EXTERNAL
 *     vertical's deploy passes through — and the reader of `sweeperClasses`, the names the
 *     push declares in its manifest so the control plane decides from a declaration, not the bytes;
 *   - this repo's `lint:schedule-sweeper` (`tools/schedule-sweeper.mts`), which imports the
 *     built copy the way `tools/invocation-log.mjs` imports boundary-lint's R10 predicate, so
 *     the two gates cannot disagree.
 *
 * Parsed with `@babel/parser` rather than TypeScript's compiler API: TypeScript 7 exposes no
 * standalone parser (see `tools/docs-union-check.mjs`), and Babel's TypeScript plugin is what
 * the repo tool already used for exactly this job.
 *
 * What this does NOT see: whether an own sweeper's roster is ever populated (`noteScope` from
 * `onProvision`). That is runtime wiring; the platform's sweeper has none to forget.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from '@babel/parser';
import { PLATFORM_SWEEPER_BINDING, PLATFORM_SWEEPER_CLASS, sweeperConflict } from '@substrat-run/contracts';

type Program = ReturnType<typeof parse>['program'];
type Statement = Program['body'][number];
type VariableDeclaration = Extract<Statement, { type: 'VariableDeclaration' }>;
type Expression = NonNullable<VariableDeclaration['declarations'][number]['init']>;

const DEFINE_SWEEPER = 'defineScopeSweeperDO';

/** One declared schedule, named by the module that declares it. */
export interface ScheduleRef {
  moduleId: string;
  operation: string;
}

export interface SweeperWiring {
  /** Names the worker entry exports that resolve to a `defineScopeSweeperDO(...)` call. */
  exportedNames: string[];
  /** Durable Object `class_name`s the deploy config binds, in whichever vocabulary it uses. */
  boundClassNames: string[];
  /** The binding names the deploy config declares, of any type (#1902). */
  boundBindingNames?: string[];
  /** {@link platformCanSupplySweeper} — `undefined` when it could not be told. */
  platformCanSupply?: boolean;
}

function nameOf(node: { type: 'Identifier'; name: string } | { type: 'StringLiteral'; value: string }): string {
  return node.type === 'Identifier' ? node.name : node.value;
}

/** Is this expression a call to (an import of) `defineScopeSweeperDO`, however named? */
function isDefineSweeperCall(node: Expression | null | undefined, importedLocalNames: Set<string>): boolean {
  if (!node || node.type !== 'CallExpression') return false;
  const callee = node.callee;
  if (callee.type === 'Identifier') return importedLocalNames.has(callee.name) || callee.name === DEFINE_SWEEPER;
  // A namespace-imported call (`adapter.defineScopeSweeperDO(...)`).
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
    return callee.property.name === DEFINE_SWEEPER;
  }
  return false;
}

/** A re-export or import this file makes from another file — what `exportedSweeperNamesOf` follows. */
interface ForeignRef {
  source: string;
  /** The name in the other file, or `'*'` for `export * from`. */
  imported: string;
  /** The name it carries out of THIS file (`'*'` for `export * from`). */
  exported: string;
}

interface ParsedEntry {
  /** Sweeper names this file exports from its own declarations. */
  own: string[];
  /** Names this file exports that come from somewhere else, to be followed by the caller. */
  foreign: ForeignRef[];
}

/**
 * `jsx` only for a `.tsx` file: in a `.ts` file `<T>value` is a type assertion, and the JSX
 * plugin would read it as an element. A `.tsx` worker with JSX does not tokenize without it.
 */
function parseEntry(source: string, jsx = false): ParsedEntry {
  const ast = parse(source, {
    sourceType: 'module',
    plugins: jsx ? ['typescript', 'jsx'] : ['typescript'],
    errorRecovery: true,
  });
  const importedLocalNames = new Set<string>();
  /** local name → where it was imported from, for `import { X } from './a'; export { X }`. */
  const importedFrom = new Map<string, { source: string; imported: string }>();
  const sweeperLocals = new Set<string>();
  const own = new Set<string>();
  const foreign: ForeignRef[] = [];

  for (const stmt of ast.program.body) {
    if (stmt.type !== 'ImportDeclaration') continue;
    for (const spec of stmt.specifiers) {
      if (spec.type !== 'ImportSpecifier') continue;
      const imported = nameOf(spec.imported);
      if (imported === DEFINE_SWEEPER) importedLocalNames.add(spec.local.name);
      importedFrom.set(spec.local.name, { source: stmt.source.value, imported });
    }
  }

  const scanDeclaration = (decl: Statement | null | undefined, directlyExported: boolean): void => {
    if (!decl) return;
    if (decl.type === 'VariableDeclaration') {
      for (const d of decl.declarations) {
        if (d.id.type === 'Identifier' && isDefineSweeperCall(d.init, importedLocalNames)) {
          sweeperLocals.add(d.id.name);
          if (directlyExported) own.add(d.id.name);
        }
      }
    } else if (decl.type === 'ClassDeclaration') {
      if (decl.id && isDefineSweeperCall(decl.superClass as Expression | null | undefined, importedLocalNames)) {
        sweeperLocals.add(decl.id.name);
        if (directlyExported) own.add(decl.id.name);
      }
    }
  };

  // Declarations first, so a re-export written ABOVE the const it names still resolves.
  for (const stmt of ast.program.body) {
    if (stmt.type === 'VariableDeclaration' || stmt.type === 'ClassDeclaration') scanDeclaration(stmt, false);
    else if (stmt.type === 'ExportNamedDeclaration' && stmt.declaration) scanDeclaration(stmt.declaration, true);
  }

  for (const stmt of ast.program.body) {
    if (stmt.type === 'ExportAllDeclaration') {
      // `export * as ns from` exports a namespace object, never a class workerd can bind.
      if (!('exported' in stmt && stmt.exported)) foreign.push({ source: stmt.source.value, imported: '*', exported: '*' });
      continue;
    }
    if (stmt.type !== 'ExportNamedDeclaration' || stmt.declaration) continue;
    for (const spec of stmt.specifiers) {
      if (spec.type !== 'ExportSpecifier') continue;
      const local = nameOf(spec.local);
      const exported = nameOf(spec.exported);
      if (stmt.source) {
        foreign.push({ source: stmt.source.value, imported: local, exported });
      } else if (sweeperLocals.has(local)) {
        // The ALIAS is the name workerd sees, so it is the one a binding has to name.
        own.add(exported);
      } else {
        const from = importedFrom.get(local);
        if (from) foreign.push({ source: from.source, imported: from.imported, exported });
      }
    }
  }
  return { own: [...own], foreign };
}

/**
 * Every name a worker entry's SOURCE exports that is bound to a `defineScopeSweeperDO(...)`
 * call, looking at this one file only — a direct `export const X = defineScopeSweeperDO(…)`,
 * an `export class X extends defineScopeSweeperDO(…) {}`, or a local declaration re-exported
 * by name or alias. A call in an unexported const contributes nothing.
 */
export function exportedSweeperNames(source: string): string[] {
  return parseEntry(source).own;
}

const SOURCE_EXTENSIONS = ['.ts', '.mts', '.tsx', '.js', '.mjs'];

/** A relative specifier as the bundler would find it on disk, or undefined. */
function resolveRelative(fromFile: string, specifier: string): string | undefined {
  const base = resolve(dirname(fromFile), specifier);
  const stem = base.replace(/\.(?:[cm]?js|jsx)$/, '');
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((ext) => stem + ext),
    ...SOURCE_EXTENSIONS.map((ext) => resolve(base, `index${ext}`)),
  ];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile());
}

/**
 * {@link exportedSweeperNames}, starting at a FILE and following relative re-exports
 * (`export { X } from './sweeper.js'`, `export * from './sweeper.js'`, and
 * `import { X } from './sweeper.js'; export { X }`). The repo's own workers define their
 * sweeper in the entry, but an external vertical is free to keep it in a module of its own,
 * and a push gate that refuses that layout would be refusing a working deploy. Package
 * specifiers are not followed: a sweeper class defined inside a dependency is not a shape
 * anyone writes, and resolving `node_modules` is the bundler's job, not this check's.
 */
export function exportedSweeperNamesOf(entryPath: string): string[] {
  const memo = new Map<string, string[]>();
  const visit = (file: string): string[] => {
    const cached = memo.get(file);
    if (cached) return cached;
    memo.set(file, []); // cycle guard: a module re-exporting itself contributes nothing more
    const { own, foreign } = parseEntry(readFileSync(file, 'utf8'), file.endsWith('.tsx'));
    const names = new Set(own);
    for (const ref of foreign) {
      if (!ref.source.startsWith('.')) continue;
      const target = resolveRelative(file, ref.source);
      if (!target) continue;
      const theirs = visit(target);
      if (ref.imported === '*') theirs.forEach((n) => names.add(n));
      else if (theirs.includes(ref.imported)) names.add(ref.exported);
    }
    const result = [...names];
    memo.set(file, result);
    return result;
  };
  return visit(resolve(entryPath));
}

/**
 * Can the platform supply this vertical's sweeper (#1902)? The class it supplies runs the
 * vertical's own host, which the vertical's `mountPlatformSurface` registers — so it needs a
 * `@substrat-run/vertical-host` new enough to register one, as installed in THIS project.
 * `undefined` when the package does not resolve from `dir` at all: this check then says
 * nothing rather than refusing on a layout it cannot read.
 */
export function platformCanSupplySweeper(dir: string): boolean | undefined {
  // Walked by hand, the way Node looks for a package next to a file, and NOT with
  // `createRequire`: that also searches NODE_PATH, which a package manager's bin shim points at
  // its own store, so a push run through `pnpm exec` would read some other copy's answer.
  for (let at = resolve(dir); ; at = dirname(at)) {
    const pkgDir = resolve(at, 'node_modules', '@substrat-run', 'vertical-host');
    const pkgJson = resolve(pkgDir, 'package.json');
    if (existsSync(pkgJson)) {
      const pkg = JSON.parse(readFileSync(pkgJson, 'utf8')) as {
        main?: string;
        exports?: { '.'?: { default?: string } | string };
      };
      const dot = pkg.exports?.['.'];
      const main = (typeof dot === 'string' ? dot : dot?.default) ?? pkg.main ?? 'index.js';
      // The registry ships as its own module beside the package's entry (`scope-sweep-host.ts`).
      return existsSync(resolve(dirname(resolve(pkgDir, main)), 'scope-sweep-host.js'));
    }
    if (dirname(at) === at) return undefined;
  }
}

/**
 * The offence in one vertical, or `null` when it is fine. No schedules declared means no
 * sweeper is owed, whatever the wiring looks like.
 *
 * Since #1902 a vertical that brings no sweeper is given the platform's at upload, so "no
 * sweeper" is no longer the offence. What is: an own sweeper nothing binds (Cloudflare never
 * instantiates it), the platform's names taken by something else (the control plane refuses
 * the push), and a vertical-host too old to hand the platform's sweeper a host. The first two
 * are contracts' `sweeperConflict`, the rule the control plane judges by too.
 */
export function sweeperOffence(schedules: readonly ScheduleRef[], wiring: SweeperWiring): string | null {
  if (schedules.length === 0) return null;
  const named = schedules.map((s) => `${s.moduleId} → ${s.operation}`).join(', ');
  const conflict = sweeperConflict(wiring.exportedNames, {
    boundClassNames: wiring.boundClassNames,
    boundBindingNames: wiring.boundBindingNames ?? [],
  });
  if (conflict?.kind === 'own-unbound') {
    return (
      `exports a sweeper (${conflict.own.join(', ')}) for schedules it declares (${named}), ` +
      `but no deploy config binds it as a Durable Object class — checked wrangler.jsonc's ` +
      `durable_objects.bindings and package.json's substrat.runtimeNeeds.stores, and neither ` +
      `names ${conflict.own.join(' or ')}. The class exists in the bundle but ` +
      `Cloudflare never instantiates it, so its alarm never runs. Bind it, or delete it: the ` +
      `platform supplies a sweeper to a vertical that exports none.`
    );
  }
  if (conflict) {
    const taken =
      conflict.kind === 'binding-taken' ? `the binding '${PLATFORM_SWEEPER_BINDING}'` : `the class name '${PLATFORM_SWEEPER_CLASS}'`;
    return (
      `declares schedules (${named}) and exports no sweeper, so the platform supplies one at upload ` +
      `as class '${PLATFORM_SWEEPER_CLASS}' bound to '${PLATFORM_SWEEPER_BINDING}' — but the deploy config ` +
      `already uses ${taken} for something that is not a \`defineScopeSweeperDO\` class, and the control ` +
      `plane would refuse the push. If it is a sweeper you have since deleted, drop its binding — the ` +
      `platform adds its own — and otherwise rename it.`
    );
  }
  if (wiring.exportedNames.length > 0) return null;
  if (wiring.platformCanSupply === false) {
    return (
      `declares schedules (${named}) and exports no sweeper. The platform supplies one at upload, ` +
      `but it runs the host your \`mountPlatformSurface\` registers, and the installed ` +
      `@substrat-run/vertical-host predates that registration — the supplied sweeper would have no ` +
      `host and no roster. Update @substrat-run/vertical-host.`
    );
  }
  return null;
}
