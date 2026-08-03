/**
 * Boundary lint — the layer rules from CLAUDE.md, enforced mechanically
 * (master plan §5.6: "lint rules banning raw DB/fetch access"; §10 enforcement
 * table).
 *
 * WHY THIS IS STATIC ANALYSIS. Every other guardrail in the platform fails
 * loud: branded IDs fail at compile time, Zod fails at the boundary, `getScope`
 * fails closed on a mismatched pair, the state machine refuses to skip. The
 * layer rules are the ones that fail SILENTLY — `SELECT * FROM
 * workorder_time_entries` returns the right rows, the test passes, and the
 * vertical is now welded to an engine's private schema forever. R5 has no
 * runtime equivalent, which is exactly why it needs a linter.
 *
 * Rules:
 *   R1 star topology   an engine never imports another @substrat-run/engine-*
 *   R2 no raw access   module code imports no better-sqlite3, no adapters,
 *                      no node builtins — data access is ctx.sql only
 *   R3 no network      module code never calls fetch() or imports an HTTP client
 *   R4 spine is sacred module code never writes _substrat_* tables (reads are
 *                      fine — timelines are projections)
 *   R5 tables private  module code never references another module's tables in
 *                      SQL (decision 28) — engine data is reached via exported
 *                      in-scope functions; the stable surface is entity ids,
 *                      EntityRefs, and event payloads. One-time extraction
 *                      handoffs (decision 27) opt out explicitly with a
 *                      `boundary-lint-allow R5` … `boundary-lint-end R5` block.
 *
 * TABLE OWNERSHIP IS DERIVED FROM MIGRATIONS, NEVER DECLARED. A table is owned
 * by whichever module's `CREATE TABLE` made it. That fact ships inside the
 * published package (the SQL survives compilation into `dist/index.js`
 * verbatim), so ownership resolves identically from a workspace checkout or an
 * installed dependency. A manifest field restating it would be a second source
 * of truth, and second sources of truth drift.
 *
 * Ownership keys on the npm PACKAGE NAME, not the directory: a workspace link
 * and a node_modules install of the same engine are the same owner, so a
 * monorepo demo importing `@substrat-run/engine-workorder` is not accused of
 * reaching into a stranger's tables.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Violation {
  /** Root-relative path. */
  file: string;
  /** 1-indexed, when the rule is line-anchored. */
  line?: number;
  rule: 'R1' | 'R2' | 'R3' | 'R4' | 'R5';
  message: string;
}

/** A unit of module code: linted, and/or the owner of the tables it creates. */
export interface PackageSpec {
  /** Owner key — the npm package name. Ownership dedupes on this. */
  name: string;
  /** Absolute directory to scan. */
  dir: string;
  /** Apply the module rules here. `false` = contributes ownership only. */
  lint: boolean;
  /** R1 applies: an engine may not import a sibling engine. */
  engine: boolean;
  /** dir-relative paths exempt from module rules (composition roots). */
  harness: string[];
  /** Directory names to skip while walking. */
  skip?: string[];
}

export interface BoundaryLintConfig {
  /**
   * Local module-code packages. Each is linted AND owns the tables its
   * migrations create. `src` is resolved relative to the project root.
   */
  packages?: Array<{
    name?: string;
    src: string;
    engine?: boolean;
    harness?: string[];
  }>;
  /**
   * Ownership-only sources: installed modules whose tables are private to them.
   * Directories relative to root; defaults to every installed
   * `@substrat-run/engine-*`. Add third-party engines here.
   */
  externals?: string[];
  /** Harness filenames applied to every package that doesn't override them. */
  harness?: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'crypto', 'dgram', 'dns',
  'events', 'fs', 'http', 'http2', 'https', 'net', 'os', 'path', 'perf_hooks',
  'process', 'readline', 'stream', 'string_decoder', 'timers', 'tls', 'url',
  'util', 'v8', 'vm', 'worker_threads', 'zlib',
]);

const HTTP_CLIENTS = new Set(['undici', 'node-fetch', 'axios', 'got', 'ky']);

/**
 * Harness = edge/server wiring, not module code reachable from a
 * ModuleRegistration. auth*.ts wires an authentication adapter (Better Auth,
 * OIDC, …) at the server edge — legitimately node/DB-touching. auth-do.ts is the
 * same adapter wiring hosted in a Durable Object (Better Auth over the DO's own
 * SQLite) — the workerd analogue of auth-node.ts; its `fetch` is the DO's request
 * interface, not a network call. worker.ts is the Cloudflare deployment entry
 * (the composition root that mounts the adapter + engines onto a Worker) — the
 * workerd analogue of server.ts. page.ts is a served SPA (an HTML/JS string the
 * worker returns) — its `fetch` is browser code, not module code, the same
 * edge-wiring class as worker.ts/routes.ts. do-contract.ts is the TYPE contract
 * of a Durable Object stub (auth-do.ts's callable shape, split out so node code
 * can import it without `cloudflare:workers`) — its `fetch` is a type signature,
 * not a call. assets.ts/assets.generated.ts are the inlined-SPA serving pair
 * (gen-assets.mjs): the generated file is the BUILT browser bundle as string
 * literals — its `fetch(` is browser code the worker serves, the same class as
 * page.ts, and it is gitignored, so linting it fails locally on content CI
 * never sees.
 */
export const DEFAULT_HARNESS = [
  'seed.ts',
  'server.ts',
  'index.ts',
  'auth.ts',
  'auth-node.ts',
  'auth-do.ts',
  'auth-adapters.ts',
  'do-contract.ts',
  'oidc.ts',
  'worker.ts',
  'routes.ts',
  'page.ts',
  'assets.ts',
  'assets.generated.ts',
];

const SOURCE_FILE = /\.(ts|tsx|js|mjs)$/;

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

function* walk(dir: string, skip: Set<string>): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (skip.has(name)) continue;
    const p = join(dir, name);
    let isDir: boolean;
    try {
      isDir = statSync(p).isDirectory();
    } catch {
      continue;
    }
    if (isDir) yield* walk(p, skip);
    else if (SOURCE_FILE.test(name)) yield p;
  }
}

function importsOf(source: string): string[] {
  const specs: string[] = [];
  const re =
    /(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
  for (let m: RegExpExecArray | null; (m = re.exec(source)); ) {
    const spec = m[1] ?? m[2];
    if (spec) specs.push(spec);
  }
  return specs;
}

const CREATE_TABLE = /CREATE TABLE (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)/gi;

/**
 * Table name → owning package name, from every `CREATE TABLE` in the package.
 *
 * `_substrat_*` tables are deliberately NOT recorded. They are the kernel's
 * spine: writes are R4's business, and READS are legal and expected (timelines
 * are projections over the outbox — CLAUDE.md). Recording them as owned would
 * make R5 fire on a documented-legal pattern.
 */
function collectTables(file: string, owner: string, tableOwners: Map<string, string>): void {
  const source = readFileSync(file, 'utf8');
  for (let m: RegExpExecArray | null; (m = CREATE_TABLE.exec(source)); ) {
    const table = m[1];
    if (!table || table.startsWith('_substrat_')) continue;
    if (!tableOwners.has(table)) tableOwners.set(table, owner);
  }
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function checkForeignTables(
  rel: string,
  source: string,
  owner: string,
  tableOwners: Map<string, string>,
  out: Violation[],
): void {
  const lines = source.split('\n');
  let allowed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.includes('boundary-lint-allow R5')) allowed = true;
    else if (line.includes('boundary-lint-end R5')) allowed = false;
    if (allowed) continue;
    for (const [table, tableOwner] of tableOwners) {
      if (tableOwner === owner) continue;
      if (new RegExp(`\\b${table}\\b`).test(line)) {
        out.push({
          file: rel,
          line: i + 1,
          rule: 'R5',
          message: `tables private — references '${table}' owned by ${tableOwner} (use its in-scope functions)`,
        });
      }
    }
  }
}

function checkModuleFile(
  file: string,
  rel: string,
  pkg: PackageSpec,
  tableOwners: Map<string, string>,
  out: Violation[],
): void {
  const source = readFileSync(file, 'utf8');

  checkForeignTables(rel, source, pkg.name, tableOwners, out);

  for (const spec of importsOf(source)) {
    if (pkg.engine && spec.startsWith('@substrat-run/engine-') && spec !== pkg.name) {
      out.push({ file: rel, rule: 'R1', message: `star topology — engine imports sibling engine '${spec}'` });
    }
    const bare = spec.startsWith('node:') ? spec.slice(5) : spec;
    if (spec === 'better-sqlite3' || spec.startsWith('@substrat-run/adapter-')) {
      out.push({ file: rel, rule: 'R2', message: `raw data access — module code imports '${spec}' (use ctx.sql)` });
    } else if (spec.startsWith('node:') || NODE_BUILTINS.has(bare)) {
      out.push({ file: rel, rule: 'R2', message: `platform escape — module code imports '${spec}'` });
    } else if (HTTP_CLIENTS.has(bare)) {
      out.push({ file: rel, rule: 'R3', message: `network — module code imports HTTP client '${spec}'` });
    }
  }

  if (/\bfetch\s*\(/.test(source)) {
    out.push({ file: rel, rule: 'R3', message: 'network — module code calls fetch()' });
  }

  const spineWrite = /(insert\s+into|update|delete\s+from)\s+["'`]?_substrat_/i.exec(source);
  if (spineWrite) {
    out.push({
      file: rel,
      rule: 'R4',
      message: `spine write — module code mutates a _substrat_* table (${spineWrite[1]})`,
    });
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function packageNameOf(dir: string, fallback: string): string {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Installed modules that own tables but are never linted here — they were
 * linted by their own CI before publish. Defaults to `@substrat-run/engine-*`;
 * third-party engines go in `config.externals`.
 *
 * Scans the package's shipped `dist`, where the migration SQL lives verbatim.
 */
function discoverExternals(root: string, configured?: string[]): PackageSpec[] {
  const specs: PackageSpec[] = [];

  if (configured) {
    for (const relDir of configured) {
      const dir = join(root, relDir);
      if (!existsSync(dir)) continue;
      specs.push({
        name: packageNameOf(dir, relDir),
        dir,
        lint: false,
        engine: false,
        harness: [],
        skip: ['node_modules'],
      });
    }
    return specs;
  }

  const scopeDir = join(root, 'node_modules', '@substrat-run');
  let entries: string[];
  try {
    entries = readdirSync(scopeDir);
  } catch {
    return specs;
  }
  for (const name of entries) {
    if (!name.startsWith('engine-')) continue;
    const dir = join(scopeDir, name);
    specs.push({
      name: packageNameOf(dir, `@substrat-run/${name}`),
      dir,
      lint: false,
      engine: false,
      harness: [],
      skip: ['node_modules'],
    });
  }
  return specs;
}

/**
 * Monorepo shape: `engines/<e>/src` (all module code, R1 applies) and
 * `demos/<d>/src` (module code minus the harness files).
 */
function discoverMonorepo(root: string, harness: string[]): PackageSpec[] {
  const specs: PackageSpec[] = [];
  for (const group of ['engines', 'demos'] as const) {
    let pkgs: string[];
    try {
      pkgs = readdirSync(join(root, group));
    } catch {
      continue;
    }
    for (const pkg of pkgs) {
      const pkgDir = join(root, group, pkg);
      const srcDir = join(pkgDir, 'src');
      if (!existsSync(srcDir)) continue;
      let name: string;
      try {
        name = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).name;
      } catch {
        continue;
      }
      if (!name) continue;
      specs.push({
        name,
        dir: srcDir,
        lint: true,
        engine: group === 'engines',
        // An engine is module code all the way down — no harness exemptions.
        harness: group === 'engines' ? [] : harness,
      });
    }
  }
  // Platform verticals living in apps/ — e.g. apps/dashboard, the platform
  // vertical (a real vertical, not a demo). Only those with a `src/module.ts`
  // (the vertical marker); the other apps (console, control-plane, router, docs)
  // are not module code and are not scanned.
  try {
    for (const pkg of readdirSync(join(root, 'apps'))) {
      const srcDir = join(root, 'apps', pkg, 'src');
      if (!existsSync(join(srcDir, 'module.ts'))) continue;
      let name: string;
      try {
        name = JSON.parse(readFileSync(join(root, 'apps', pkg, 'package.json'), 'utf8')).name;
      } catch {
        continue;
      }
      if (name) specs.push({ name, dir: srcDir, lint: true, engine: false, harness });
    }
  } catch {
    /* no apps/ */
  }
  return specs;
}

/** Standalone vertical: one package, module code in `src`. */
function discoverStandalone(root: string, harness: string[]): PackageSpec[] {
  const srcDir = join(root, 'src');
  if (!existsSync(srcDir)) return [];
  return [
    {
      name: packageNameOf(root, 'the vertical'),
      dir: srcDir,
      lint: true,
      engine: false,
      harness,
    },
  ];
}

/**
 * Engine packages the project DECLARES a dependency on.
 *
 * This is what separates the two cases an empty ownership map can mean:
 *
 *   - "R5 has nothing to check because this vertical composes no engines" —
 *     legitimate. A vertical may own its whole domain (an e-commerce vertical
 *     reaching invoicing purely by event imports nothing). R5 is inert, and that
 *     is a fact about the project, not a failure of the linter.
 *   - "R5 checked nothing because the engines are declared but unresolvable" —
 *     a broken setup, and a silent pass. This is the case exit 2 exists for.
 *
 * Conflating them made zero-engine verticals unlintable, which contradicted the
 * documented (and supported) shape. The monorepo hid it: there, engines are
 * linted packages rather than externals, so the ownership map is never empty in
 * the way a standalone vertical's is.
 */
export function declaredEngines(root: string, config?: BoundaryLintConfig): string[] {
  // Explicit config is a declaration: the author said where engines live.
  if (config?.externals) return config.externals;
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const deps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
      ...(pkg.peerDependencies ?? {}),
    };
    return Object.keys(deps).filter((n) => n.startsWith('@substrat-run/engine-'));
  } catch {
    return [];
  }
}

export function loadConfig(root: string): BoundaryLintConfig | undefined {
  for (const file of ['boundary-lint.config.json', '.boundary-lintrc.json']) {
    const p = join(root, file);
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')) as BoundaryLintConfig;
  }
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    if (pkg?.substrat?.boundaryLint) return pkg.substrat.boundaryLint as BoundaryLintConfig;
  } catch {
    /* no package.json — fall through to auto-detection */
  }
  return undefined;
}

export function resolvePackages(root: string, config?: BoundaryLintConfig): PackageSpec[] {
  const harness = config?.harness ?? DEFAULT_HARNESS;

  const local: PackageSpec[] = config?.packages
    ? config.packages.map((p) => ({
        name: p.name ?? packageNameOf(join(root, p.src, '..'), p.src),
        dir: join(root, p.src),
        lint: true,
        engine: p.engine ?? false,
        harness: p.harness ?? harness,
      }))
    : [...discoverMonorepo(root, harness), ...discoverStandalone(root, harness)].filter(
        // A monorepo root with its own src/ would double-count; monorepo wins.
        (p, _i, all) => !(all.length > 1 && p.name === 'the vertical'),
      );

  const externals = discoverExternals(root, config?.externals);
  const localNames = new Set(local.map((p) => p.name));

  // Dedupe: an engine present in the workspace AND in node_modules is one
  // owner. The workspace copy wins — it is the one being linted.
  return [...local, ...externals.filter((e) => !localNames.has(e.name))];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function lint(root: string, config?: BoundaryLintConfig): Violation[] {
  const packages = resolvePackages(root, config ?? loadConfig(root));
  const tableOwners = new Map<string, string>();
  const violations: Violation[] = [];

  // Pass 1: ownership. Harness files included — a table is owned wherever it
  // is created, and every package contributes, linted or not.
  for (const pkg of packages) {
    const skip = new Set(pkg.skip ?? ['node_modules', 'dist']);
    for (const file of walk(pkg.dir, skip)) collectTables(file, pkg.name, tableOwners);
  }

  // Pass 2: the rules, over local module code only.
  for (const pkg of packages) {
    if (!pkg.lint) continue;
    const skip = new Set(pkg.skip ?? ['node_modules', 'dist']);
    const harness = new Set(pkg.harness);
    for (const file of walk(pkg.dir, skip)) {
      const inPkg = relative(pkg.dir, file).split(sep).join('/');
      if (harness.has(inPkg)) continue;
      checkModuleFile(file, relative(root, file), pkg, tableOwners, violations);
    }
  }

  return violations;
}

export function formatViolations(violations: Violation[]): string {
  return violations
    .map((v) => `  ✗ ${v.file}${v.line ? `:${v.line}` : ''}: ${v.rule} ${v.message}`)
    .join('\n');
}
