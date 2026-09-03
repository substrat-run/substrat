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
 *                      no node builtins, no `cloudflare:workers` — data access
 *                      is ctx.sql only and the host injects every capability.
 *                      `cloudflare:workers` is the workerd analogue of `node:*`
 *                      and belongs to the same ban for a sharper reason: it
 *                      exports an AMBIENT `env` (verified — `export const env:
 *                      Cloudflare.Env`), so one import hands module code every
 *                      binding and secret the vertical's script declares,
 *                      including its own `SCOPE` DO namespace. `ctx.sql` is
 *                      closed over one scope's storage and cannot reach
 *                      another; `env.SCOPE.idFromName(…)` can, which makes this
 *                      the one import that turns the scope boundary from
 *                      physical into advisory. Harness code (worker.ts,
 *                      *-do.ts) legitimately imports `DurableObject` from it
 *                      and is exempt, as it is for `node:*`.
 *   R3 no network      module code never calls fetch() or imports an HTTP client
 *   R4 spine is sacred module code never writes _substrat_* tables (reads are
 *                      fine — timelines are projections)
 *   R5 tables private  module code never references another module's tables in
 *                      SQL (decision 28) — engine data is reached via exported
 *                      in-scope functions; the stable surface is entity ids,
 *                      EntityRefs, and event payloads. One-time extraction
 *                      handoffs (decision 27) opt out explicitly with a
 *                      `boundary-lint-allow R5` … `boundary-lint-end R5` block.
 *   R6 no clock        module code never reads the wall clock (`new Date()`,
 *                      `Date.now()`) — the operation's instant is `ctx.now()`
 *                      (#812). The same class of ban as R2's `node:*`: a
 *                      capability the host owns and injects, so a scenario can
 *                      freeze it and a replay can control it. `new Date(value)`
 *                      with an argument is untouched — parsing a timestamp you
 *                      were given is not reading a clock. Code that must read
 *                      the REAL clock — a JWT whose `exp` a remote server
 *                      judges, host-driving code outside any operation — opts
 *                      out explicitly with a `boundary-lint-allow R6` …
 *                      `boundary-lint-end R6` block, the same reviewable hatch
 *                      R5 uses. Unlike R5's, this one has a recurring
 *                      legitimate case, so it is a hatch rather than a
 *                      one-time handoff.
 *   R7 no bare catch   module code never catches an engine error outside
 *                      `ctx.atomic` (#786, sequenced after #770 so the lint has
 *                      a mechanism to point at). An engine in-scope function
 *                      composed inside your transaction has no boundary of its
 *                      own, so a `catch` around it leaves you holding the
 *                      engine's partial writes — the rows its invariants were
 *                      protecting — and commits them. `ctx.atomic(() => …)` is
 *                      the boundary; inside one, catching is legal and the
 *                      callee's rows, events, links, grants and platform
 *                      intents are all discarded. See §2 and §7 of
 *                      docs/architecture/sub-transactions.md.
 *
 *                      `try`/`finally` with no `catch` is fine (it does not
 *                      swallow), and so is a catch that always rethrows
 *                      (`catch (e) { log(e); throw e }`) — the operation still
 *                      fails and the whole transaction rolls back, which is the
 *                      outcome the rule exists to preserve. There is NO
 *                      `boundary-lint-allow` hatch: unlike R5's one-time data
 *                      handoff or R6's real-clock JWT, there is no legitimate
 *                      reason to swallow an engine error unprotected, and a
 *                      hatch here would only ever be used to silence the rule.
 *   R8 no SELECT *     an ENGINE never reads with a star (#970, the mechanical
 *                      half of #771's seam). `SELECT *` pins the shape an engine
 *                      publishes to whatever its physical table currently holds,
 *                      so a vertical compiled against 0.3 and running against
 *                      0.4 reads a field that moved and gets WRONG DATA on a
 *                      screen — never a throw. A read names its columns
 *                      (`columnsOf(schema)`) and the value goes out through
 *                      `returns(schema, …)`. Engine packages only: a vertical
 *                      starring its own table has no seam to break, and R5
 *                      already stops it starring somebody else's. The reviewable
 *                      `boundary-lint-allow R8` … `boundary-lint-end R8` hatch
 *                      exists for the one shape that is not a seam — a migration
 *                      or maintenance read of the engine's own table where the
 *                      row never leaves the engine.
 *
 * NUMBERING. Rule numbers are claimed WHEN THEY SHIP, not when they are
 * proposed. #786's "catch outside ctx.atomic" rule was drafted as R6 while
 * unbuilt; the no-clock rule landed first and took the number, so #786 shipped
 * as R7 — the issue title still says R6 because it predates #812
 * (docs/architecture/sub-transactions.md §2 records the renumbering). Two rules
 * sharing a number would be worse than a stale title.
 *
 * R7 AND THE PARSER QUESTION (#786 open question 1, decided here). R7 needs two
 * things R1–R6 do not: which identifiers are bound to an engine import, and
 * whether a call site sits lexically inside a `ctx.atomic` callback. Neither is
 * line-local, and both were the argument for pulling in the TypeScript compiler.
 * They are NOT, and this ships without one: `typescript` in `dependencies` is
 * ~20MB of runtime dependency in a package that has none today and installs into
 * every scaffolded vertical, to answer questions that need a token scanner
 * rather than a type checker. What R7 uses instead is `maskSource` — one pass
 * that blanks comments, string bodies and regex literals while preserving every
 * offset — after which brace matching over the masked text answers both
 * questions exactly. The pass runs ONLY on files that import an
 * `@substrat-run/engine-*` package at all, so the common case stays a set
 * lookup.
 *
 * The deliberate limits, stated rather than discovered (#786 open question 5 —
 * a rule that misfires gets suppressed wholesale, which is worse than no rule).
 * All three under-fire:
 *
 *   - R7 sees only calls written INSIDE the `try`, so an engine call moved into
 *     a local helper is missed.
 *   - An UNBRACED conditional rethrow as the catch's last statement
 *     (`catch (e) { if (rare) throw e; }`) sits at top level and is read as an
 *     always-rethrow. The braced form (`catch (e) { if (rare) { throw e } }`) is
 *     flagged, because there the throw is not the catch's last top-level
 *     statement and the catch runs on past it.
 *   - The rule is the `catch` CLAUSE, as #786 states it. The promise spelling —
 *     `await completeWorkOrder(ctx, x).catch(() => null)` — is the same bug and
 *     is not flagged. No module code in this repo writes it, and widening to it
 *     is a change to this file with fixtures, not a change of character.
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
  rule: 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7' | 'R8';
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
  // The auth adapter's own table definitions (Better Auth's Drizzle schema),
  // imported only by auth-do.ts / server.ts. Same class as the rest of auth*.ts
  // and named separately only because the list is literal: its `new Date()`
  // defaults are the LIBRARY's storage contract, not a Substrat row's stamp, so
  // R6 has nothing to say about them.
  'auth-schema.ts',
  // The auth adapter's own network boundary: the transport that fetches a Client ID
  // Metadata Document, whose `client_id` IS an HTTPS URL. Same class as the rest of
  // auth*.ts and imported only by them. R3 bans `fetch` in module code because
  // capabilities come from `ctx` — but an issuer resolving a CIMD client has no `ctx`
  // and no connector to delegate to: fetching that document is what the OAuth draft
  // defines the client id to MEAN. The file exists separately from auth-do.ts precisely
  // so the guarantees it can and cannot make are reviewable in one place.
  'cimd-fetch.ts',
  'do-contract.ts',
  // The per-instance CONFIG store hosted in a Durable Object — the durable half of
  // `/internal/configure`. Same class as auth-do.ts: the config a scope runs on is
  // not domain data, it is reached through a binding rather than `ctx.sql`, and the
  // `cloudflare:workers` import is the DO base class the runtime requires, not a
  // reach for the ambient env. `create-substrat` scaffolds one, so until this entry
  // existed every new project failed its own R2 gate on minute one.
  'config-do.ts',
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

/**
 * R6 — module code has no clock (#812).
 *
 * Argless `new Date()` and `Date.now()` only. `new Date(row.created_at)` and
 * `Date.parse(x)` are reading a value somebody already stamped, which is
 * ordinary data handling; the ban is on ORIGINATING a timestamp, because that
 * is the act the host has to own for a frozen clock or a replay to mean
 * anything.
 *
 * Comment lines are skipped. This file's own header names both spellings, and a
 * rule that cannot be described in a comment without firing on the description
 * is a rule people delete.
 */
const WALL_CLOCK = /\bnew\s+Date\s*\(\s*\)|\bDate\s*\.\s*now\s*\(\s*\)/;

function checkClock(rel: string, source: string, out: Violation[]): void {
  const lines = source.split('\n');
  let inBlockComment = false;
  let allowed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (line.includes('boundary-lint-allow R6')) allowed = true;
    else if (line.includes('boundary-lint-end R6')) allowed = false;
    if (allowed) continue;
    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlockComment = true;
      continue;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    const m = WALL_CLOCK.exec(line);
    if (m) {
      out.push({
        file: rel,
        line: i + 1,
        rule: 'R6',
        message: `no clock — module code reads the wall clock ('${m[0]}'); use ctx.now()`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// R7 — catching an engine error outside ctx.atomic (#786)
//
// The scanner the header's parser decision commits to. Everything below works on
// a MASKED copy of the source: same length, same line breaks, same offsets, with
// comments, string bodies and regex literals blanked to spaces. After that pass,
// every `{`, `}`, `(` and `)` left in the text is real syntax, so brace matching
// is exact and a regex cannot be fooled by a brace inside a string.
// ---------------------------------------------------------------------------

const ENGINE_SCOPE = '@substrat-run/engine-';

/** A `/` here starts a regex, not a division — decided from what precedes it. */
const REGEX_AFTER_KEYWORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'case', 'do', 'else', 'yield',
  'await', 'delete', 'void', 'throw', 'new',
]);

function regexAllowed(masked: string[], at: number): boolean {
  let i = at - 1;
  while (i >= 0 && /\s/.test(masked[i] ?? '')) i--;
  if (i < 0) return true;
  const c = masked[i]!;
  // Quotes survive masking (only their bodies are blanked), so they count as
  // operands here too — `'a'.length / 2` must not read as a regex.
  if (/[\w$)\]'"`]/.test(c)) {
    // An identifier or a closing bracket: division — unless the identifier is a
    // keyword that cannot be followed by one (`return /x/.test(s)`).
    let j = i;
    while (j >= 0 && /[\w$]/.test(masked[j] ?? '')) j--;
    return REGEX_AFTER_KEYWORD.has(masked.slice(j + 1, i + 1).join(''));
  }
  return true;
}

/**
 * Comments, string bodies and regex literals blanked; offsets and newlines kept.
 *
 * Template literals keep their `${…}` expressions — an engine call can live in
 * one, and the braces are balanced either way — and blank only the literal text
 * between them, which is where a stray `{` or quote would otherwise come from.
 *
 * `{ literals: false }` blanks the COMMENTS only and leaves every string body
 * standing. That is what R8 needs: SQL lives in string literals, so blanking
 * them would blank the only text the rule looks at, while the prose warning
 * against `SELECT *` lives in the docblock right above it and must not fire the
 * rule that the prose describes. The scanner still walks strings, template
 * literals and regexes the same way — it has to, or a `//` inside a string would
 * read as a comment — it just does not erase them.
 */
function maskSource(src: string, opts: { literals?: boolean } = {}): string {
  const maskLiterals = opts.literals !== false;
  const out = src.split('');
  const n = src.length;
  const blank = (from: number, to: number): void => {
    for (let k = Math.max(from, 0); k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  // Template-literal nesting: each entry is the `${` depth inside that template.
  const templates: number[] = [];
  let i = 0;
  while (i < n) {
    const c = src[i]!;
    const next = src[i + 1];

    if (templates.length > 0 && templates[templates.length - 1] === 0) {
      // Inside the literal text of a template — blank until `${`, `` ` `` or an escape.
      if (c === '\\') { if (maskLiterals) blank(i, i + 2); i += 2; continue; }
      if (c === '`') { templates.pop(); i++; continue; }
      if (c === '$' && next === '{') { templates[templates.length - 1] = 1; i += 2; continue; }
      if (maskLiterals) blank(i, i + 1);
      i++;
      continue;
    }

    if (c === '/' && next === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const j = end < 0 ? n : end + 2;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c || src[j] === '\n') break;
        j++;
      }
      if (maskLiterals) blank(i + 1, j);
      i = j + 1;
      continue;
    }
    if (c === '`') {
      templates.push(0);
      i++;
      continue;
    }
    if (c === '/' && regexAllowed(out, i)) {
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        const d = src[j]!;
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') break;
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
        j++;
      }
      if (j < n && src[j] === '/') {
        if (maskLiterals) blank(i + 1, j);
        i = j + 1;
        continue;
      }
      // Unterminated — it was a division after all.
    }
    // Inside a `${…}` expression: count its braces, so that reaching zero hands
    // the next character back to the literal-text branch at the top.
    if (templates.length > 0) {
      if (c === '{') templates[templates.length - 1]! += 1;
      else if (c === '}') templates[templates.length - 1]! -= 1;
    }
    i++;
  }
  return out.join('');
}

interface EngineBindings {
  /** Local names bound to an engine's value exports. */
  names: Set<string>;
  /** Local names bound to `import * as ns` of an engine. */
  namespaces: Set<string>;
}

const IMPORT_CLAUSE =
  /(?:^|[\n;])[ \t]*import\s+([^'"]*?)\s*from\s*['"]([^'"]+)['"]/g;

/**
 * Which local identifiers in this file call into an engine.
 *
 * Aliases (`import { completeWorkOrder as finish }`) resolve to the LOCAL name —
 * that is the one appearing at the call site. Type-only imports are skipped in
 * both spellings (`import type { … }` and an inline `type Foo` specifier): a
 * type never throws.
 */
function engineBindings(source: string): EngineBindings {
  const names = new Set<string>();
  const namespaces = new Set<string>();
  IMPORT_CLAUSE.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = IMPORT_CLAUSE.exec(source)); ) {
    const spec = m[2] ?? '';
    if (!spec.startsWith(ENGINE_SCOPE)) continue;
    let clause = (m[1] ?? '').trim();
    if (/^type\b/.test(clause)) continue;

    const ns = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(clause);
    if (ns?.[1]) namespaces.add(ns[1]);

    const braced = /\{([\s\S]*)\}/.exec(clause);
    if (braced?.[1] !== undefined) {
      for (const raw of braced[1].split(',')) {
        const part = raw.trim();
        if (!part || /^type\b/.test(part)) continue;
        const alias = /\bas\s+([A-Za-z_$][\w$]*)\s*$/.exec(part);
        const local = alias?.[1] ?? part.split(/\s+/)[0];
        if (local && /^[A-Za-z_$][\w$]*$/.test(local)) names.add(local);
      }
      clause = clause.replace(/\{[\s\S]*\}/, '');
    }

    // Whatever is left of the clause is a default import.
    const def = clause.replace(/\*\s*as\s+[A-Za-z_$][\w$]*/, '').split(',')[0]?.trim();
    if (def && /^[A-Za-z_$][\w$]*$/.test(def) && def !== 'type') names.add(def);
  }
  return { names, namespaces };
}

/** Index of the delimiter closing the one at `open`, or -1. */
function matchDelim(masked: string, open: number, openCh: string, closeCh: string): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const c = masked[i];
    if (c === openCh) depth += 1;
    else if (c === closeCh) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function isWord(masked: string, at: number, word: string): boolean {
  if (!masked.startsWith(word, at)) return false;
  const before = masked[at - 1];
  const after = masked[at + word.length];
  return !(before && /[\w$.]/.test(before)) && !(after && /[\w$]/.test(after));
}

/**
 * The argument spans of every `ctx.atomic(…)` — the regions in which catching an
 * engine error is legal.
 *
 * Matched on the CALL, not on `ctx`: `atomic` may be reached through a local
 * alias or destructured off the context (`const { atomic } = ctx`), and both
 * spellings mean the same boundary. Matching any `atomic(` over-exempts a
 * same-named local function, which is the direction this rule errs in on
 * purpose.
 */
function atomicRegions(masked: string): Array<[number, number]> {
  const regions: Array<[number, number]> = [];
  const re = /(?:^|[^\w$])(?:[A-Za-z_$][\w$]*\s*\.\s*)?atomic\s*\(/g;
  for (let m: RegExpExecArray | null; (m = re.exec(masked)); ) {
    const open = m.index + m[0].length - 1;
    const close = matchDelim(masked, open, '(', ')');
    if (close > 0) regions.push([open, close]);
    re.lastIndex = open + 1;
  }
  return regions;
}

/** The first engine call in [start, end) that no `ctx.atomic` covers. */
function unguardedEngineCall(
  masked: string,
  start: number,
  end: number,
  bindings: EngineBindings,
  regions: Array<[number, number]>,
): { name: string; offset: number } | undefined {
  const region = masked.slice(start, end);
  const hits: Array<{ name: string; offset: number }> = [];

  // Group 3, where the pattern has one, is the MEMBER of a namespace call. The
  // message quotes what the developer wrote and suggests wrapping it, so a
  // namespace hit has to report `wo.completeWorkOrder` — reporting the binding
  // alone names something un-callable and suggests `ctx.atomic(() => wo(…))`,
  // which is not valid code and does not locate the call either.
  const push = (re: RegExp, binding: string): void => {
    re.lastIndex = 0;
    for (let m: RegExpExecArray | null; (m = re.exec(region)); ) {
      // `new SlotUnavailable(…)` constructs an error; it never writes rows.
      if (m[2]) continue;
      hits.push({
        name: m[3] ? `${binding}.${m[3]}` : binding,
        offset: start + m.index + (m[1]?.length ?? 0),
      });
    }
  };

  // Optional-call syntax is the same call. `completeWorkOrder?.(ctx, x)` writes
  // the same rows as `completeWorkOrder(ctx, x)` and throws the same error, so
  // `?.` before the argument list — and, for a namespace, in place of the member
  // dot — is matched rather than left as a spelling that walks past the rule.
  //
  // Interpolated only with identifiers this file validated against
  // /^[A-Za-z_$][\w$]*$/ — no metacharacters reach the pattern, and it has no
  // nested quantifier to back off through.
  for (const name of bindings.names) {
    push(new RegExp(`(^|[^.\\w$])(new\\s+)?${name}\\s*(?:\\?\\.)?\\s*\\(`, 'g'), name);
  }
  for (const ns of bindings.namespaces) {
    push(
      new RegExp(
        `(^|[^.\\w$])(new\\s+)?${ns}\\s*\\??\\.\\s*([A-Za-z_$][\\w$]*)\\s*(?:\\?\\.)?\\s*\\(`,
        'g',
      ),
      ns,
    );
  }

  hits.sort((a, b) => a.offset - b.offset);
  return hits.find((h) => !regions.some(([o, c]) => h.offset > o && h.offset < c));
}

/**
 * Does this catch block always rethrow?
 *
 * True when its LAST top-level statement is a `throw` — `catch (e) { log(e);
 * throw e }`, the most common legitimate shape. The operation still fails, the
 * whole transaction rolls back, and nobody is left holding partial writes.
 * Rethrowing a wrapped error counts for the same reason.
 *
 * A `throw` inside an `if` BLOCK does not, because it is not the last top-level
 * statement and the catch runs on past it — `catch (e) { if (fatal(e)) { throw e
 * } return null }` has a path that swallows, and that path is the bug. The
 * UNBRACED spelling of the same intent, `catch (e) { if (rare) throw e; }`, is
 * at top level and does count: the known under-fire named in this file's header,
 * kept because tightening it means parsing the `if` rather than the block.
 */
function rethrows(masked: string, start: number, end: number): boolean {
  let depth = 0;
  let lastThrow = -1;
  for (let i = start; i < end; i++) {
    const c = masked[i]!;
    if (c === '{' || c === '(' || c === '[') depth += 1;
    else if (c === '}' || c === ')' || c === ']') depth -= 1;
    else if (depth === 0 && isWord(masked, i, 'throw')) {
      lastThrow = i;
      i += 4;
    }
  }
  if (lastThrow < 0) return false;

  // Everything after that statement must be blank, or the catch resumes.
  let depth2 = 0;
  let i = lastThrow + 'throw'.length;
  for (; i < end; i++) {
    const c = masked[i]!;
    if (c === '{' || c === '(' || c === '[') depth2 += 1;
    else if (c === '}' || c === ')' || c === ']') depth2 -= 1;
    else if (depth2 === 0 && (c === ';' || c === '\n')) {
      i += 1;
      break;
    }
  }
  return masked.slice(i, end).trim() === '';
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) if (source[i] === '\n') line += 1;
  return line;
}

function checkEngineCatch(rel: string, source: string, out: Violation[]): void {
  if (!source.includes(ENGINE_SCOPE) || !source.includes('try')) return;
  const bindings = engineBindings(source);
  if (bindings.names.size === 0 && bindings.namespaces.size === 0) return;

  const masked = maskSource(source);
  const regions = atomicRegions(masked);
  const tries = /(?:^|[^\w$.])try\s*\{/g;

  for (let m: RegExpExecArray | null; (m = tries.exec(masked)); ) {
    const open = m.index + m[0].length - 1;
    const close = matchDelim(masked, open, '{', '}');
    tries.lastIndex = open + 1;
    if (close < 0) continue;

    // `try`/`finally` swallows nothing — question 2, confirmed.
    let after = close + 1;
    while (after < masked.length && /\s/.test(masked[after] ?? '')) after += 1;
    if (!isWord(masked, after, 'catch')) continue;

    // Step over the binding first: `catch ({ message })` is legal, and its brace
    // is not the block's.
    let bodyFrom = after + 'catch'.length;
    while (bodyFrom < masked.length && /\s/.test(masked[bodyFrom] ?? '')) bodyFrom += 1;
    if (masked[bodyFrom] === '(') {
      const paramEnd = matchDelim(masked, bodyFrom, '(', ')');
      if (paramEnd < 0) continue;
      bodyFrom = paramEnd + 1;
    }
    const catchOpen = masked.indexOf('{', bodyFrom);
    if (catchOpen < 0) continue;
    const catchClose = matchDelim(masked, catchOpen, '{', '}');
    if (catchClose < 0) continue;
    if (rethrows(masked, catchOpen + 1, catchClose)) continue;

    const call = unguardedEngineCall(masked, open + 1, close, bindings, regions);
    if (!call) continue;

    out.push({
      file: rel,
      line: lineAt(source, call.offset),
      rule: 'R7',
      message:
        `engine error caught outside ctx.atomic — '${call.name}' is called in a try whose ` +
        `catch (line ${lineAt(source, after)}) swallows it, leaving the engine's partial writes ` +
        `to commit. Wrap the call: await ctx.atomic(() => ${call.name}(…))`,
    });
  }
}

// ---------------------------------------------------------------------------
// R8 — `SELECT *` in an engine (#970)
// ---------------------------------------------------------------------------

/**
 * `SELECT *`, `SELECT DISTINCT *` and the qualified `SELECT t.*` — every
 * spelling that hands back whatever columns the table happens to have today.
 *
 * `SELECT COUNT(*)` and `SELECT max(*)` do not match: after `SELECT` comes an
 * identifier followed by `(`, not a star, and a count returns a number rather
 * than a row shape. `\s` spans newlines, so the formatted
 * `SELECT\n  *\n  FROM …` is caught too and anchors on the `SELECT`.
 */
const SELECT_STAR = /\bselect\s+(?:distinct\s+)?(?:[A-Za-z_][\w$]*\s*\.\s*)?\*/gi;

/**
 * Does this line carry `marker` as a DIRECTIVE — in a comment, where a reviewer
 * reads it — rather than as data?
 *
 * An opt-out is a statement to the next human, so `const help = 'write
 * boundary-lint-allow R8 above it'` must not open one. Decided by position
 * against the comment-stripped line, which is the same length and offsets as the
 * original: text a comment held is blank there, text a string held is not. R5
 * and R6 still scan the raw line, because neither builds a stripped copy —
 * tightening them is a change to those rules with their own fixtures.
 */
function marks(line: string, stripped: string, marker: string): boolean {
  for (let at = line.indexOf(marker); at >= 0; at = line.indexOf(marker, at + 1)) {
    if (stripped.slice(at, at + marker.length).trim() === '') return true;
  }
  return false;
}

/**
 * R8 — an engine read names its columns.
 *
 * The counterpart to #771's runtime seam: `returns(schema, surface, value)`
 * parses on the way out, and `columnsOf(schema)` is what the SELECT should list,
 * so the published shape is the schema's rather than the table's. A star defeats
 * both — the parse sees whatever the physical row holds, and a column that moved
 * between two engine versions reaches a vertical's screen as wrong data instead
 * of a throw.
 *
 * Runs on a COMMENT-STRIPPED copy with the strings intact (`maskSource(source,
 * { literals: false })`), for the reason that function's docblock gives: every
 * engine in this repo warns against `SELECT *` in prose sitting directly above
 * the read it is warning about, and a rule that fires on its own description is
 * a rule people delete. Offsets survive masking, so the reported line is the
 * line in the original file.
 */
function checkSelectStar(rel: string, source: string, out: Violation[]): void {
  if (!/select/i.test(source)) return;

  const stripped = maskSource(source, { literals: false });
  const lines = source.split('\n');
  const strippedLines = stripped.split('\n');

  const allowed = new Set<number>();
  let on = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const bare = strippedLines[i] ?? '';
    if (marks(line, bare, 'boundary-lint-allow R8')) on = true;
    else if (marks(line, bare, 'boundary-lint-end R8')) on = false;
    if (on) allowed.add(i + 1);
  }

  SELECT_STAR.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = SELECT_STAR.exec(stripped)); ) {
    const line = lineAt(source, m.index);
    if (allowed.has(line)) continue;
    out.push({
      file: rel,
      line,
      rule: 'R8',
      message:
        `star read in an engine — '${m[0].replace(/\s+/g, ' ')}' publishes whatever columns the ` +
        `table currently holds, so a moved column reaches a vertical as wrong data rather than a ` +
        `throw. Name the columns (columnsOf(schema)) and return through returns(schema, …)`,
    });
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
  checkClock(rel, source, out);
  checkEngineCatch(rel, source, out);
  if (pkg.engine) checkSelectStar(rel, source, out);

  for (const spec of importsOf(source)) {
    if (pkg.engine && spec.startsWith('@substrat-run/engine-') && spec !== pkg.name) {
      out.push({ file: rel, rule: 'R1', message: `star topology — engine imports sibling engine '${spec}'` });
    }
    const bare = spec.startsWith('node:') ? spec.slice(5) : spec;
    if (spec === 'better-sqlite3' || spec.startsWith('@substrat-run/adapter-')) {
      out.push({ file: rel, rule: 'R2', message: `raw data access — module code imports '${spec}' (use ctx.sql)` });
    } else if (spec === 'cloudflare:workers') {
      out.push({
        file: rel,
        rule: 'R2',
        message:
          `ambient env — module code imports '${spec}', which exports the whole environment ` +
          `(every binding and secret, including the SCOPE DO namespace). Capabilities come from ` +
          `ctx; harness code (worker.ts, *-do.ts) is where DurableObject is imported`,
      });
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
    const dist = join(dir, 'dist');
    specs.push({
      // The OWNER is the package; the SCAN is its dist, where the migration SQL
      // lives verbatim. Narrowed to dist when there is one, because a directory
      // that is not shipped code can still contain the words `CREATE TABLE` —
      // an assertion message reading "no CREATE TABLE for <name>" in an engine's own
      // test suite registers a table called `for`, and every consumer that says
      // `for` in any SQL then "references a private table". A published install is
      // dist-only so this never fired there; a workspace-linked one (a monorepo
      // linting its own scaffold template) points at the full source tree.
      name: packageNameOf(dir, `@substrat-run/${name}`),
      dir: existsSync(dist) ? dist : dir,
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
        // An engine is module code all the way down — no harness exemptions, the
        // same as `discoverMonorepo` gives `engines/*`. The default list exempts
        // `index.ts`, which in an engine is not a composition root but the whole
        // surface, so a config-declared engine was skipping the one file every
        // rule is about. An explicit `harness` still wins: saying so is a
        // declaration, and this only fills in the default.
        harness: p.harness ?? (p.engine ? [] : harness),
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
