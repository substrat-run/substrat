/**
 * The handoff between a vertical's bundle and the scope sweeper the platform supplies (#1902).
 *
 * A vertical that declares `manifest.schedules` and exports no `defineScopeSweeperDO` class
 * of its own is given one at upload: the uploader adds the class, its `SWEEPER` binding and
 * its migration. That class is the platform's code, prebuilt, and it cannot know the one
 * thing a pass needs — the vertical's own scope host, with the vertical's modules and its
 * host options (service principals, declared connectors, attachment extractors). A host
 * rebuilt from the modules alone would drain a declared connector's events as if no
 * connector were declared, so it has to be the vertical's.
 *
 * Every deployed vertical already hands that host to `mountPlatformSurface` as `hostFor`,
 * so that is where it is registered — on `globalThis` under a GLOBAL symbol, because the
 * platform's copy of the reader and the vertical-host the vertical bundled are different
 * module instances that meet only there (the same reason #1893's stamp registry is global).
 *
 * The roster is the other half. The platform's sweeper is told which scopes exist by
 * `mountPlatformSurface` itself, on provision, reconcile and delete-scope — but only when the
 * upload says it supplied one: the uploader sets `SUBSTRAT_SCOPE_SWEEPER` to the binding's
 * name. A vertical that brings its own sweeper keeps its own hooks and never sees the var.
 *
 * Zero imports on purpose: `tools/platform-entry-emit.mts` bundles this file into the
 * platform's sweeper module, which is added to every such upload.
 */

const HOSTS = Symbol.for('substrat.scope-sweep-host');

/** The env var the uploader sets to the binding of the sweeper it supplied (#1902). Contracts'
 *  `PLATFORM_SWEEPER_VAR`, spelled out because this file imports nothing; control-plane-api's
 *  `platform-entry.test.ts` holds the two equal. */
export const PLATFORM_SWEEPER_VAR = 'SUBSTRAT_SCOPE_SWEEPER';

/** Builds this deployment's scope host from the worker env — `mountPlatformSurface`'s `hostFor`. */
export type ScopeSweepHostFactory = (env: never) => unknown;

/** Record the vertical's host builder for the platform's sweeper. The last call wins. */
export function registerScopeSweepHost(hostFor: ScopeSweepHostFactory): void {
  (globalThis as unknown as Record<symbol, ScopeSweepHostFactory | undefined>)[HOSTS] = hostFor;
}

/** The host builder the vertical registered, or `undefined` when its bundle registers none. */
export function registeredScopeSweepHost(): ScopeSweepHostFactory | undefined {
  return (globalThis as unknown as Record<symbol, ScopeSweepHostFactory | undefined>)[HOSTS];
}

/** The slice of a sweeper stub the surface calls. */
interface RosterStub {
  noteScope(tenantId: string, scopeId: string): Promise<unknown>;
  forgetScope(scopeId: string): Promise<unknown>;
}

interface Namespace {
  idFromName(name: string): unknown;
  get(id: unknown): unknown;
}

/** `SCOPE_SWEEPER_NAME` in adapter-cloudflare — the singleton every caller addresses. */
const SCOPE_SWEEPER_NAME = 'scope-sweeper';

/**
 * The platform-supplied sweeper's stub, or `undefined` when this upload was given none —
 * which is every local run, and every vertical that wires its own.
 */
export function platformSweeperOf(env: object): RosterStub | undefined {
  const vars = env as Record<string, unknown>;
  const binding = vars[PLATFORM_SWEEPER_VAR];
  if (typeof binding !== 'string' || !binding) return undefined;
  const ns = vars[binding] as Namespace | undefined;
  if (!ns || typeof ns.idFromName !== 'function') {
    throw new Error(
      `${PLATFORM_SWEEPER_VAR} names the binding '${binding}', but this script has no Durable Object namespace by that name`,
    );
  }
  return ns.get(ns.idFromName(SCOPE_SWEEPER_NAME)) as RosterStub;
}
