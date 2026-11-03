import { declaredMigration, migrationDigestOf, reviewLine, z, type DeclaredMigration } from '@substrat-run/contracts';
import type { VerticalBundle } from './deploy.js';
import { PLATFORM_MODULES, platformEntryFlags } from './platform-entry.js';

/**
 * The control plane reads a version's migrations from its bundle (#2351). The scope host that
 * applies a version's migrations is code inside the vertical's own bundle, so the set the push
 * declared and the set the bundle registers are two lists that nothing else ties together. The
 * control plane evaluates the bundle in an isolate with no bindings and no network, asks each
 * class `defineScopeDO` made for what it registers (`REGISTERED_MIGRATIONS`), and gates on it:
 * a push whose declared migrations are not the registered ones is refused before upload. The
 * stored set is then the registered set; nothing is stored in its place.
 *
 * What it reads is what the bundle registers when evaluated without its bindings, so this is an
 * integrity check on the build, not an isolation boundary: the apply-time check (#2349) stays.
 */

/** Evaluate a bundle and read what it registers: null when it exposes no registrations. Throws `MigrationExtractionError`. */
export type ExtractMigrationsFn = (
  bundle: Pick<VerticalBundle, 'entry' | 'compatibilityDate' | 'compatibilityFlags' | 'modules'>,
) => Promise<DeclaredMigration[] | null>;

/** A bundle that could not be evaluated, did not settle, or whose answer does not read: the bundle's own outcome. */
export class MigrationExtractionError extends Error {
  override readonly name = 'MigrationExtractionError';
}

/**
 * The loader itself failed: the platform could not run the read, which says nothing about the
 * bundle. Retryable, so a caller never answers it as the bundle's fault.
 */
export class MigrationLoaderUnavailable extends Error {
  override readonly name = 'MigrationLoaderUnavailable';
}

/** The part of a Worker Loader binding this uses (`WorkerLoader` in workers-types). */
export interface MigrationLoader {
  get(
    id: string,
    code: () => {
      compatibilityDate: string;
      compatibilityFlags?: string[];
      mainModule: string;
      modules: Record<string, string | { js?: string; cjs?: string; text?: string; data?: ArrayBuffer; json?: unknown; wasm?: ArrayBuffer }>;
      env?: Record<string, never>;
      globalOutbound?: null;
      limits?: { cpuMs?: number };
    },
  ): { getEntrypoint(): { fetch(url: string): Promise<Response> } };
}

/** The main module of the loaded worker. Not a name a bundle can ship: no bundler emits `:`. */
const EXTRACT_MODULE = 'substrat:extract-migrations.js';
/** A bundle must start inside the runtime's 1 s startup limit to deploy at all; twice that, for the read. */
const EXTRACT_CPU_MS = 2000;
/** How long a read may take in wall time before it counts as a bundle that does not settle. */
const EXTRACT_TIMEOUT_MS = 10_000;
/** How much of a bundle's own error text a refusal quotes. */
const ERROR_TEXT_MAX = 500;

const clip = (text: string): string => (text.length > ERROR_TEXT_MAX ? `${text.slice(0, ERROR_TEXT_MAX)}…` : text);
const unevaluable = (why: string) => new MigrationExtractionError(`the worker entry could not be evaluated without its bindings: ${clip(why)}`);
/** What the runtime says when the loaded worker went over its `limits`, or hung: the bundle's outcome, not the loader's. */
const OVER_LIMIT = /exceeded (its )?(cpu|resource|memory)|had hung/i;

/**
 * Imports the vertical's entry inside the request, so a throw at its top level is an answer
 * rather than a worker that never starts, and returns every exported class's registrations.
 */
const extractSource = (entry: string) => `
const MARK = Symbol.for('substrat.registeredMigrations');
const failed = (e) => Response.json({ error: String((e && e.message) || e) });
export default {
  async fetch() {
    let mod;
    try { mod = await import(${JSON.stringify(`./${entry}`)}); } catch (e) { return failed(e); }
    const classes = [];
    try {
      for (const value of Object.values(mod)) {
        if (typeof value === 'function' && typeof value[MARK] === 'function') classes.push(value[MARK]());
      }
    } catch (e) { return failed(e); }
    return Response.json({ classes });
  },
};
`;

/**
 * A module as the loader takes it, by its content type. A push sends every part as an ES module
 * (the CLI labels each `application/javascript+module`), so a push reads as `js` throughout; the
 * other kinds are for an archive script read back, whose parts carry the runtime's own types.
 */
function moduleOf(m: VerticalBundle['modules'][number]) {
  const bytes = m.content;
  const text = () => new TextDecoder().decode(bytes);
  const buffer = () => bytes.slice().buffer;
  if (m.contentType.includes('wasm')) return { wasm: buffer() };
  if (m.contentType.startsWith('text/')) return { text: text() };
  if (m.contentType.includes('json')) return { json: JSON.parse(text()) as unknown };
  if (m.contentType === 'application/octet-stream') return { data: buffer() };
  if (m.contentType === 'application/javascript' || m.name.endsWith('.cjs')) return { cjs: text() };
  return { js: text() };
}

const sha256 = async (bytes: Uint8Array): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** The loader id: every input of the loaded worker, each module by its content's digest. */
async function bundleId(bundle: Parameters<ExtractMigrationsFn>[0]): Promise<string> {
  const modules = await Promise.all(bundle.modules.map(async (m) => [m.name, m.contentType, await sha256(m.content)]));
  return sha256(new TextEncoder().encode(JSON.stringify([bundle.entry, bundle.compatibilityDate, bundle.compatibilityFlags, modules])));
}

/**
 * An `ExtractMigrationsFn` over a Worker Loader binding. The loaded worker is the vertical's own
 * modules (a platform module an archive script carries is left out) behind a main module of the
 * platform's, with `env: {}` and `globalOutbound: null`, so the bundle reaches nothing while it
 * evaluates, and `limits.cpuMs`. Keyed by the bundle's content, so the same bytes evaluated again
 * reuse the isolate.
 *
 * Whose outcome a failure is decides how it is answered: an error the bundle's entry threw, a read
 * over its limits, or one that does not settle within `timeoutMs` is a `MigrationExtractionError`;
 * any other failure of the loader is a `MigrationLoaderUnavailable`.
 */
export function loaderMigrationExtractor(loader: MigrationLoader, options: { timeoutMs?: number } = {}): ExtractMigrationsFn {
  const timeoutMs = options.timeoutMs ?? EXTRACT_TIMEOUT_MS;
  return async (bundle) => {
    const own = bundle.modules.filter((m) => !PLATFORM_MODULES.has(m.name));
    const id = await bundleId({ ...bundle, modules: own });
    let raw: unknown;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsettled = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(unevaluable(`it did not settle within ${timeoutMs} ms`)), timeoutMs);
    });
    try {
      const stub = loader.get(id, () => ({
        compatibilityDate: bundle.compatibilityDate,
        // The flags the bundle is uploaded with: the uploader may add `nodejs_als` (#2245).
        compatibilityFlags: platformEntryFlags(bundle.compatibilityFlags).flags,
        mainModule: EXTRACT_MODULE,
        modules: { ...Object.fromEntries(own.map((m) => [m.name, moduleOf(m)])), [EXTRACT_MODULE]: extractSource(bundle.entry) },
        env: {},
        globalOutbound: null,
        limits: { cpuMs: EXTRACT_CPU_MS },
      }));
      raw = await Promise.race([stub.getEntrypoint().fetch('https://extract.invalid/').then((res) => res.json()), unsettled]);
    } catch (e) {
      if (e instanceof MigrationExtractionError) throw e;
      const message = e instanceof Error ? e.message : String(e);
      if (OVER_LIMIT.test(message)) throw unevaluable(message);
      throw new MigrationLoaderUnavailable(`the platform could not read this bundle's migrations (${clip(message)}); push again`);
    } finally {
      clearTimeout(timer);
    }
    return readExtraction(raw);
  };
}

const extraction = z.union([
  z.object({ classes: z.array(z.array(declaredMigration)) }).strict(),
  z.object({ error: z.string() }).strict(),
]);

/**
 * The loaded worker's answer, which is the bundle's data, parsed as a push's migrations are.
 * Classes that register the same module must register the same migrations for it; their
 * registrations are otherwise one set, in the order they came.
 */
export function readExtraction(raw: unknown): DeclaredMigration[] | null {
  const parsed = extraction.safeParse(raw);
  if (!parsed.success) throw new MigrationExtractionError('the bundle answered with migrations that do not read as migrations');
  if ('error' in parsed.data) {
    throw unevaluable(parsed.data.error);
  }
  if (parsed.data.classes.length === 0) return null;
  const byModule = new Map<string, DeclaredMigration[]>();
  for (const registered of parsed.data.classes) {
    for (const [moduleId, migrations] of groupByModule(registered)) {
      const seen = byModule.get(moduleId);
      if (seen && extractedMigrationsProblem(seen, migrations)) {
        throw new MigrationExtractionError(`two Durable Object classes register module ${reviewLine(moduleId)} with different migrations`);
      }
      byModule.set(moduleId, migrations);
    }
  }
  return [...byModule.values()].flat();
}

function groupByModule(migrations: readonly DeclaredMigration[]): Map<string, DeclaredMigration[]> {
  const out = new Map<string, DeclaredMigration[]>();
  for (const m of migrations) {
    const list = out.get(m.moduleId);
    if (list) list.push(m);
    else out.set(m.moduleId, [m]);
  }
  return out;
}

const sameRecord = (a: Readonly<Record<string, string>> | undefined, b: Readonly<Record<string, string>> | undefined) =>
  JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b ?? {}).sort());

/**
 * Why the migrations a push declares are not the ones its bundle registers, or null when they
 * are: migration for migration within each module, by version, exact SQL and the declared
 * `moves` and `discards`. The order of the modules is not compared (the permission entry and
 * the worker entry may list them differently), the order inside a module is.
 */
export function extractedMigrationsProblem(
  declared: readonly DeclaredMigration[],
  registered: readonly DeclaredMigration[],
): string | null {
  const d = groupByModule(declared);
  const r = groupByModule(registered);
  for (const moduleId of [...new Set([...d.keys(), ...r.keys()])].sort()) {
    const a = d.get(moduleId) ?? [];
    const b = r.get(moduleId) ?? [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i];
      const y = b[i];
      if (x && y && x.version === y.version && x.sql === y.sql && sameRecord(x.moves, y.moves) && sameRecord(x.discards, y.discards)) {
        continue;
      }
      const where = `module ${reviewLine(moduleId)}`;
      if (!y) return `${where}: the push declares ${reviewLine(x!.version)}, which the bundle does not register`;
      if (!x) return `${where}: the bundle registers ${reviewLine(y.version)}, which the push does not declare`;
      if (x.version !== y.version) return `${where}: the push declares ${reviewLine(x.version)} where the bundle registers ${reviewLine(y.version)}`;
      return `${where}: ${reviewLine(x.version)} ${x.sql !== y.sql ? 'has other SQL' : 'declares other moves or discards'} in the bundle than in the push`;
    }
  }
  return null;
}

/** The sentence a push or a promote is refused with when the two sets differ. */
export const extractedMigrationsRefusal = (problem: string): string =>
  `the migrations this version's bundle registers are not the ones its push declared (${problem}). ` +
  'Push again from the build that is deployed, so the stored migrations are the ones it runs (#2351)';

/**
 * What `migrations_extracted` holds for a version: the digest of the migrations read from its
 * bundle. Canonical form: `migrationDigestOf` with no store classes over the registered set,
 * modules ordered by id (ascending, by UTF-16 code unit) and each module's migrations in the
 * order the host applies them; per migration its module, version, the SHA-256 of its exact SQL,
 * and its `moves` and `discards` when it declares any, as `stableJson` frames them. So module
 * order, which the bundle chooses, does not move it, and any change to the SQL or to what a
 * migration declares does.
 */
export function extractedMigrationsDigest(registered: readonly DeclaredMigration[]): Promise<string> {
  const ordered = [...groupByModule(registered)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).flatMap(([, ms]) => ms);
  return migrationDigestOf({ doClasses: [], migrations: ordered });
}
