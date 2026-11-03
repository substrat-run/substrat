import {
  LIST_PAGE_MAX,
  mayHoldScopeStores,
  scopeStoresDeclaredIn,
  STORE_DRIVERS,
  issueScopeStoreEnvelope,
  SCOPE_STORE_ENVELOPE_HEADER,
  SCOPE_STORE_SIGNATURE_HEADER,
  ScopeStoreKeyError,
  STORE_CALL_MAX_BYTES,
  scopeStoreBodyBytes,
  scopeStoreObjectName,
  scopeStoreScriptName,
  storeEraseResult,
  STORE_FENCE_OPERATION,
  storeRequest,
  storeResponse,
  storeSizeResult,
  storeWipeResult,
  StoreError,
  type PlatformActorId,
  type ReservedStoreOperation,
  type Scope,
  type StoreDriverRegistration,
} from '@substrat-run/contracts';
import { callReservedStoreOperation, type HostAdmin, type ReservedStoreCall } from '@substrat-run/kernel';
import { ControlPlaneError } from '@substrat-run/control-plane-client';
import { storedDeployManifest } from './deploy.js';
import { PAGE_CALL_DEADLINE_MS, retryTransientOver, withDeadline } from './vertical-client.js';

/**
 * A reserved scope-store call, made by the control plane straight at the store
 * script (#2207). The vertical is not on this path: it holds neither the
 * namespace nor the key. The key signs the envelope here, audience `platform`,
 * which is the only audience a `substrat.*` operation accepts.
 */
export interface PlatformScopeStoreDispatch {
  /** PKCS8 Ed25519 private key, base64url. Signs audience `platform`. */
  readonly platformKey: string;
  fetch(scriptName: string, request: Request): Promise<Response>;
  /** How long one store call may take, its answer read, ms. Default `PAGE_CALL_DEADLINE_MS`. */
  readonly deadlineMs?: number;
  /** The wait before each retry of a call that met a transient fault, ms. Default `STORE_CALL_RETRY_DELAYS_MS`. */
  readonly retryDelaysMs?: readonly number[];
}

/** ~3 s worst case between the three tries a store call gets, as a provisioning call's are. */
export const STORE_CALL_RETRY_DELAYS_MS: readonly number[] = [750, 2500];

export interface PlatformScopeStoreTarget {
  readonly vertical: string;
  readonly driver: string;
  readonly tenantId: string;
  readonly scopeId: string;
  readonly binding: string;
}

/** One declared binding, as a version manifest lists it. */
export interface DeclaredScopeStore {
  readonly binding: string;
  readonly driver: string;
}

export interface PlatformScopeStores {
  /**
   * One reserved call on one store object, under a deadline and with a transient fault retried
   * (`platformScopeStoresFor`). Everything that moves a store's data goes through this, a page at a
   * time (`store-move.ts`), so nothing here holds a dump.
   */
  callStore(target: PlatformScopeStoreTarget): ReservedStoreCall;
  eraseSubject(input: {
    tenantId: string;
    scopeId: string;
    vertical: string;
    subjectId: string;
    stores: readonly DeclaredScopeStore[];
  }): Promise<{ binding: string; erased: number }[]>;
  /**
   * Fence each store and wipe it, for a scope that is being deleted (`substrat.fence`, D-70). The
   * object refuses a caller from then on, whenever the call was signed, and refuses a platform call
   * that would write. It is one call to the object, so a retry runs the whole of it again.
   */
  fenceStores(input: {
    tenantId: string;
    scopeId: string;
    vertical: string;
    stores: readonly DeclaredScopeStore[];
  }): Promise<void>;
  sizeStores(input: {
    tenantId: string;
    scopeId: string;
    vertical: string;
    stores: readonly DeclaredScopeStore[];
  }): Promise<{ binding: string; bytes: number }[]>;
}

/** Bindings a version manifest declares. Missing JSON is none. Unreadable JSON fails closed. */
export function declaredStoresOf(manifestJson: string | null): DeclaredScopeStore[] {
  if (!manifestJson) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(manifestJson);
  } catch {
    throw new ControlPlaneError(503, 'scope store declarations could not be read');
  }
  const parsed = storedDeployManifest.safeParse(raw);
  if (!parsed.success) {
    throw new ControlPlaneError(503, 'scope store declarations could not be read');
  }
  return parsed.data.scopeStores;
}

/**
 * The version a scope's deployment runs, read once (#2207, L14). A scope with a serving pin runs
 * the serving pointer's version when the pointer's ref is its pin, and an unknown one otherwise;
 * a scope with no pin runs its bound version. `servingPointer` is the pointer as read, for a scope
 * with a pin: the pair a subject-erasure claim requires to still hold (#2285). A pointer that
 * cannot be read refuses (503): neither the version nor the fence can be named.
 */
export interface RunningVersion {
  readonly versionId: string | null;
  readonly servingPointer?: { ref: string; versionId: string } | null;
}

export async function runningVersionOf(
  admin: Pick<HostAdmin, 'verticalServing'>,
  actor: PlatformActorId,
  scope: Pick<Scope, 'vertical' | 'verticalVersionId' | 'servingRef'>,
): Promise<RunningVersion> {
  if (!scope.vertical || !scope.servingRef) return { versionId: scope.verticalVersionId };
  let pointer: Awaited<ReturnType<HostAdmin['verticalServing']>>;
  try {
    pointer = await admin.verticalServing(actor, scope.vertical);
  } catch {
    throw new ControlPlaneError(503, `the serving pointer of '${scope.vertical}' could not be read`);
  }
  const servingPointer = pointer ? { ref: pointer.ref, versionId: pointer.versionId } : null;
  return { versionId: servingPointer?.ref === scope.servingRef ? servingPointer.versionId : null, servingPointer };
}

/**
 * Stop the router serving a scope, before its stores are wiped (#2285, L6). The router admits a
 * scope only while one of its hostnames is `active`, and it reads that row on every request, so
 * unbinding is immediate. Unbind is idempotent: a retry after a failed wipe finds nothing left
 * to remove. A hostname set merely non-active would not hold — the issuance reconcile heals a
 * platform hostname back to `active`.
 */
export async function unrouteScope(
  admin: Pick<HostAdmin, 'listHostnames' | 'unbindHostname'>,
  actor: PlatformActorId,
  scope: Pick<Scope, 'tenantId' | 'id'>,
): Promise<void> {
  // Every page: an unbind deletes the row, so each read starts again from the first hostname left.
  // A row still listed after its unbind would loop forever, so it refuses instead.
  const unbound = new Set<string>();
  for (;;) {
    const page = await admin.listHostnames(actor, { tenantId: scope.tenantId, scopeId: scope.id, limit: LIST_PAGE_MAX });
    if (page.length === 0) return;
    for (const { hostname } of page) {
      if (unbound.has(hostname)) throw new Error(`hostname '${hostname}' is still bound after its unbind`);
      // Only while the row still names this scope: a name rebound elsewhere since the list stays bound.
      await admin.unbindHostname(actor, hostname, { tenantId: scope.tenantId, scopeId: scope.id });
      unbound.add(hostname);
    }
  }
}

/**
 * The scope stores of the version a scope's deployment runs (#2207). A scope on its vertical's
 * serving pin runs the serving pointer's version, and any other scope its bound version; this
 * is the version the router reads a scope's stores from (`READ_ROUTE_SQL`), and the one a restore
 * may import into (L8). The lifecycle reaches more: `scopeStoresOf`. Provisioning sets the
 * serving pin and no bound version, so reading the bound version alone answers "no store" for an
 * ordinary install whose store the router serves. A pin that names another script than the
 * pointer's is unknown, as #2242's erasure gate has it.
 *
 * The vertical's record of declared bindings is read first (`declaredRecordOf`): with no driver
 * registered, or a record that says the vertical has declared none, the answer is none; a record
 * that cannot be read refuses. Only then is the running version read, and a version that cannot be
 * named, a manifest that cannot be read, or one the gate (`mayHoldScopeStores`) says may hold a
 * store without naming it refuses (503), rather than let a backup, a wipe, a replay or an erasure
 * skip a store that may hold data (#2394). A bind or promote that lands after the read is the
 * erasure fence's to refuse, as it is for a version that declares none.
 *
 * `running` is a resolution the caller already holds (`runningVersionOf`), so a caller that fences
 * on the version reads it once and judges the stores against the same read.
 */
export async function runningVersionStoresOf(
  admin: Pick<HostAdmin, 'verticalServing' | 'versionManifest' | 'verticalScopeStores'>,
  actor: PlatformActorId,
  scope: Pick<Scope, 'id' | 'vertical' | 'verticalVersionId' | 'servingRef'>,
  drivers: readonly StoreDriverRegistration[] = STORE_DRIVERS,
  running?: RunningVersion,
): Promise<DeclaredScopeStore[]> {
  const record = await declaredRecordOf(admin, actor, scope, drivers);
  return record.length === 0 ? [] : runningStoresOfDeclaring(admin, actor, scope, drivers, running);
}

/**
 * The vertical's record of every binding any version declared, read first and once: a vertical
 * that never declared a store answers none with this one read, which is what the sweep pays for
 * almost every scope it meters or reaps. Sound because a store exists only under a binding some
 * version declared: the router reaches a store only through a version row's manifest
 * (`READ_ROUTE_SQL`), every insert of a version row records its bindings in the same transaction,
 * and the read itself first indexes any stored version not yet indexed, so the record covers every
 * version the vertical holds (#2292). A record that cannot be read refuses (503). None, with no
 * read, where nothing can hold a store: no vertical, or no driver registered.
 */
async function declaredRecordOf(
  admin: Pick<HostAdmin, 'verticalScopeStores'>,
  actor: PlatformActorId,
  scope: Pick<Scope, 'vertical'>,
  drivers: readonly StoreDriverRegistration[],
): Promise<readonly DeclaredScopeStore[]> {
  if (!scope.vertical || !mayHoldScopeStores(undefined, drivers)) return [];
  return storesDeclaredBy(admin, actor, scope.vertical);
}

/** The running version's stores, for a scope whose vertical has declared at least one (the record says so). */
async function runningStoresOfDeclaring(
  admin: Pick<HostAdmin, 'verticalServing' | 'versionManifest'>,
  actor: PlatformActorId,
  scope: Pick<Scope, 'id' | 'vertical' | 'verticalVersionId' | 'servingRef'>,
  drivers: readonly StoreDriverRegistration[],
  running?: RunningVersion,
): Promise<DeclaredScopeStore[]> {
  const vertical = scope.vertical!;
  const { versionId } = running ?? await runningVersionOf(admin, actor, scope);
  const manifestJson = versionId
    ? await admin.versionManifest(actor, vertical, versionId).catch(() => undefined)
    : undefined;
  if (!mayHoldScopeStores(manifestJson, drivers)) return [];
  const declared = typeof manifestJson === 'string' && scopeStoresDeclaredIn(manifestJson) ? declaredStoresOf(manifestJson) : [];
  if (declared.length > 0) return declared;
  throw new ControlPlaneError(503, `scope ${scope.id} may hold scope stores, and the version it runs cannot say which`);
}

/** Every binding any version of `vertical` declared (#2286); a record that cannot be read refuses (503). */
async function storesDeclaredBy(
  admin: Pick<HostAdmin, 'verticalScopeStores'>,
  actor: PlatformActorId,
  vertical: string,
): Promise<readonly DeclaredScopeStore[]> {
  try {
    return await admin.verticalScopeStores(actor, vertical);
  } catch {
    throw new ControlPlaneError(503, `the scope stores '${vertical}' has declared could not be read`);
  }
}

/**
 * What the lifecycle reaches for a scope (#2286, L17): the running version's stores
 * (`runningVersionStoresOf`, which still fails closed first), and every binding any version of its
 * vertical has declared (`HostAdmin.verticalScopeStores`, read by its keys). Export, wipe, erasure
 * and the meter reach `all`, so an object under a binding a later version dropped is still
 * reached. A restore imports only into `running` (L8). The record is read once, first, and judges
 * both.
 *
 * A binding keeps its driver for the life of the vertical, since publish refuses a driver change; a
 * running version whose driver disagrees with the record, or a record that cannot be read,
 * refuses (503).
 */
export async function scopeStoreReachOf(
  admin: Pick<HostAdmin, 'verticalServing' | 'versionManifest' | 'verticalScopeStores'>,
  actor: PlatformActorId,
  scope: Pick<Scope, 'id' | 'vertical' | 'verticalVersionId' | 'servingRef'>,
  drivers: readonly StoreDriverRegistration[] = STORE_DRIVERS,
  running?: RunningVersion,
): Promise<{ running: DeclaredScopeStore[]; all: DeclaredScopeStore[] }> {
  const record = await declaredRecordOf(admin, actor, scope, drivers);
  if (record.length === 0) return { running: [], all: [] };
  const current = await runningStoresOfDeclaring(admin, actor, scope, drivers, running);
  const all = new Map(record.map((store) => [store.binding, store.driver]));
  for (const store of current) {
    const driver = all.get(store.binding);
    if (driver !== undefined && driver !== store.driver) {
      throw new ControlPlaneError(503, `scope store '${store.binding}' is declared as both '${driver}' and '${store.driver}'`);
    }
    all.set(store.binding, store.driver);
  }
  return { running: current, all: [...all].map(([binding, driver]) => ({ binding, driver })) };
}

/** `scopeStoreReachOf`'s `all`: every store the lifecycle reaches for a scope (#2286). */
export async function scopeStoresOf(
  admin: Pick<HostAdmin, 'verticalServing' | 'versionManifest' | 'verticalScopeStores'>,
  actor: PlatformActorId,
  scope: Pick<Scope, 'id' | 'vertical' | 'verticalVersionId' | 'servingRef'>,
  drivers: readonly StoreDriverRegistration[] = STORE_DRIVERS,
  running?: RunningVersion,
): Promise<DeclaredScopeStore[]> {
  return (await scopeStoreReachOf(admin, actor, scope, drivers, running)).all;
}

/**
 * A store's own refusal or fault, as the control plane carries it on: the status it answered. A 503 is
 * a store busy bringing restored data forward (D-69), which clears by itself, so a job waits it out
 * (`isStoreBusy`). `retryAfterMs` is the answer's `Retry-After`, when it had one.
 */
export class ScopeStoreFault extends ControlPlaneError {
  constructor(status: number, message: string, readonly retryAfterMs?: number) {
    super(status, message);
  }
}

/** Whether a fault is a store saying it is busy (503), not the control plane failing to reach or sign. */
export const isStoreBusy = (e: unknown): e is ScopeStoreFault => e instanceof ScopeStoreFault && e.status === 503;

/** How long a store's answer asked to be left alone, ms; 0 when it did not say. Callers cap it to what they can wait. */
export const retryAfterOf = (e: unknown): number => (e instanceof ScopeStoreFault && e.retryAfterMs ? e.retryAfterMs : 0);

/** A `Retry-After` header as milliseconds: delta-seconds or an HTTP date. Undefined when absent or unreadable. */
export function retryAfterMsOf(header: string | null, now: number = Date.now()): number | undefined {
  if (header === null) return undefined;
  const text = header.trim();
  const ms = /^\d+$/.test(text) ? Number(text) * 1000 : Date.parse(text) - now;
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

function asControlPlane(error: unknown, retryAfterMs?: number): never {
  if (error instanceof StoreError) {
    throw new ScopeStoreFault(error.storeStatus, error.message, retryAfterMs);
  }
  throw error;
}

/** Sign the envelope and POST the reserved operation at that driver's script. */
export async function callPlatformScopeStore(
  dispatch: PlatformScopeStoreDispatch,
  target: PlatformScopeStoreTarget,
  operation: ReservedStoreOperation,
  input?: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  return callPlatformScopeStoreAt(
    dispatch,
    {
      scriptName: scopeStoreScriptName(target.vertical, target.driver),
      objectName: scopeStoreObjectName(target.tenantId, target.vertical, target.scopeId, target.binding),
    },
    operation,
    input,
    signal,
  );
}

/**
 * The same call at a named script and object: the platform's canary (#2300), which no
 * (vertical, scope) names. Its answer is parsed as every reserved answer is.
 */
export async function callPlatformScopeStoreAt(
  dispatch: PlatformScopeStoreDispatch,
  target: { readonly scriptName: string; readonly objectName: string },
  operation: ReservedStoreOperation,
  input?: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  let retryAfterMs: number | undefined;
  try {
    return await callReservedStoreOperation(
      signedStoreSend(dispatch, target, signal, (response) => { retryAfterMs = retryAfterMsOf(response.headers.get('retry-after')); }),
      operation,
      input,
    );
  } catch (error) {
    asControlPlane(error, retryAfterMs);
  }
}

/** Sign one request, audience `platform`, POST it at the script, and answer the store's JSON, or null for none. */
function signedStoreSend(
  dispatch: PlatformScopeStoreDispatch,
  { scriptName, objectName }: { readonly scriptName: string; readonly objectName: string },
  signal?: AbortSignal,
  answered?: (response: Response) => void,
): (request: { operation: string; input?: unknown }) => Promise<unknown> {
  return async (request) => {
    if (!dispatch.platformKey) {
      throw new ControlPlaneError(503, 'this control plane holds no scope-store key');
    }
    const body = JSON.stringify({ ...request, objectName });
    // The store entry refuses a body over the limit (#2811), so it is refused here, before it is signed.
    const bytes = scopeStoreBodyBytes(body);
    if (bytes > STORE_CALL_MAX_BYTES) {
      throw new ControlPlaneError(
        413,
        `scope store call '${request.operation}' carries a body of ${bytes} bytes, over the limit of ${STORE_CALL_MAX_BYTES}. Nothing was sent.`,
      );
    }
    let issued;
    try {
      issued = await issueScopeStoreEnvelope({
        privateKey: dispatch.platformKey,
        aud: 'platform',
        script: scriptName,
        name: objectName,
        op: request.operation,
        body,
      });
    } catch (error) {
      if (!(error instanceof ScopeStoreKeyError)) throw error;
      // Set but unusable, e.g. a raw key where PKCS8 belongs. The message never carries the key.
      console.warn(`scope store call refused: STORE_PLATFORM_KEY is set but unusable (${error.message})`);
      throw new ControlPlaneError(503, 'this control plane holds no usable scope-store key');
    }
    let response: Response;
    try {
      response = await dispatch.fetch(
        scriptName,
        new Request('https://scope-store/invoke', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [SCOPE_STORE_ENVELOPE_HEADER]: issued.header,
            [SCOPE_STORE_SIGNATURE_HEADER]: issued.signature,
          },
          body,
          ...(signal ? { signal } : {}),
        }),
      );
    } catch (error) {
      // An end that cannot be reached is a fault to retry, not a route's 500.
      throw new ControlPlaneError(502, `scope store script '${scriptName}' could not be reached: ${error instanceof Error ? error.message : String(error)}`);
    }
    answered?.(response);
    try {
      return await response.json();
    } catch {
      return null;
    }
  };
}

/**
 * `substrat.fence` on one store object (D-70): the entry fences it and the driver wipes it. The entry
 * answers with the driver's wipe, held to what a wipe answers. An entry older than the fence refuses
 * the call outside the envelope, which reads as `bad_envelope` (502): the reap stops there, and no
 * store is taken for fenced that was not.
 */
async function callPlatformStoreFence(
  dispatch: PlatformScopeStoreDispatch,
  target: PlatformScopeStoreTarget,
  signal?: AbortSignal,
): Promise<void> {
  const send = signedStoreSend(
    dispatch,
    {
      scriptName: scopeStoreScriptName(target.vertical, target.driver),
      objectName: scopeStoreObjectName(target.tenantId, target.vertical, target.scopeId, target.binding),
    },
    signal,
  );
  try {
    const parsed = storeResponse.safeParse(await send(storeRequest.parse({ operation: STORE_FENCE_OPERATION })));
    if (!parsed.success) throw new StoreError({ code: 'bad_envelope', status: 502, body: parsed.error.issues });
    if ('error' in parsed.data) throw new StoreError(parsed.data.error);
    const wiped = storeWipeResult.safeParse(parsed.data.result);
    if (!wiped.success) throw new StoreError({ code: 'bad_envelope', status: 502, body: wiped.error.issues });
  } catch (error) {
    asControlPlane(error);
  }
}

/**
 * A commit refused on its retry, after an earlier try whose answer was lost: that try may have landed
 * and another writer then moved on, so a refusal here does not say the store was left as it was.
 */
export class RefusedAfterRetry extends ControlPlaneError {
  constructor(cause: ControlPlaneError) {
    super(cause.status, cause.message);
  }
}

/**
 * The reserved operations a platform call makes. Each runs under a deadline and retries a transient
 * fault with backoff; a refusal, the 5 MB limit's 413 and a 409 among them, is never retried. A retry
 * is safe by the contract (D-69): a read and a discard change nothing, a page already staged answers
 * `staged: false` and changes nothing, and a commit asked again for the stage last committed answers
 * the same count. So a `staged: false` on a retry is this call's own lost answer, and is answered as
 * staged. A refusal on a commit's retry surfaces as a failure, as the contract has it, marked
 * `RefusedAfterRetry`: the first try's answer was lost, so the commit may have landed.
 */
export function platformScopeStoresFor(dispatch: PlatformScopeStoreDispatch): PlatformScopeStores {
  const delays = dispatch.retryDelaysMs ?? STORE_CALL_RETRY_DELAYS_MS;
  const deadlineMs = dispatch.deadlineMs ?? PAGE_CALL_DEADLINE_MS;
  const bounded = <T>(target: PlatformScopeStoreTarget, operation: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> =>
    withDeadline(`'${operation}'`, deadlineMs, run, `scope store '${target.binding}'`);
  const call = (target: PlatformScopeStoreTarget, operation: ReservedStoreOperation, input?: unknown): Promise<unknown> => {
    let tries = 0;
    return retryTransientOver(delays, async () => {
      tries += 1;
      const answer = await bounded(target, operation, (signal) => callPlatformScopeStore(dispatch, target, operation, input, signal)).catch((e: unknown) => {
        // A 5xx body is stripped on its way to a caller, so the sentence has to say what a 503 means.
        if (isStoreBusy(e)) {
          throw new ScopeStoreFault(
            503,
            `scope store '${target.binding}' is busy: it answered 503 to '${operation}', as a store bringing restored data forward does until it is done. Nothing was lost; ask again shortly.`,
            e.retryAfterMs,
          );
        }
        const refused = e instanceof ControlPlaneError && e.status < 500 && e.status !== 0;
        throw refused && tries > 1 && operation === 'substrat.commit-stage' ? new RefusedAfterRetry(e) : e;
      });
      if (tries > 1 && operation === 'substrat.stage-page' && (answer as { staged?: unknown }).staged === false) {
        return { staged: true };
      }
      return answer;
    });
  };
  return {
    callStore: (target) => ((operation, input) => call(target, operation, input)) as ReservedStoreCall,
    async eraseSubject({ tenantId, scopeId, vertical, subjectId, stores }) {
      const erased = [];
      for (const store of stores) {
        const { erased: count } = storeEraseResult.parse(
          await call({ ...store, tenantId, scopeId, vertical }, 'substrat.erase', { subjectId }),
        );
        erased.push({ binding: store.binding, erased: count });
      }
      return erased;
    },
    async fenceStores({ tenantId, scopeId, vertical, stores }) {
      for (const store of stores) {
        const target = { ...store, tenantId, scopeId, vertical };
        await retryTransientOver(delays, () =>
          bounded(target, STORE_FENCE_OPERATION, (signal) => callPlatformStoreFence(dispatch, target, signal)),
        );
      }
    },
    async sizeStores({ tenantId, scopeId, vertical, stores }) {
      const sizes = [];
      for (const store of stores) {
        const { bytes } = storeSizeResult.parse(
          await call({ ...store, tenantId, scopeId, vertical }, 'substrat.size'),
        );
        sizes.push({ binding: store.binding, bytes });
      }
      return sizes;
    },
  };
}

/**
 * The caller of a hosted control plane that has no route to the store scripts (#2207): every
 * call is refused (503). A hosted control plane always passes a caller, this one included, so
 * a missing route refuses the backup, wipe or erasure that needs a store instead of skipping it.
 */
export function unreachablePlatformScopeStores(): PlatformScopeStores {
  const refuse = async (): Promise<never> => {
    throw new ControlPlaneError(503, 'this control plane cannot reach scope stores');
  };
  return { callStore: () => refuse as ReservedStoreCall, eraseSubject: refuse, fenceStores: refuse, sizeStores: refuse };
}
