import {
  errorCodeOf,
  RESERVED_STORE_OPERATIONS,
  STORE_OPERATION_NAME_MAX,
  StoreError,
  storeEraseInput,
  storeEraseResult,
  storeExportResult,
  storeImportInput,
  storeImportResult,
  storeOperationName,
  storeRequest,
  storeResponse,
  storeSizeResult,
  storeWipeResult,
  substratError,
  type CheckSubject,
  type PlatformActorId,
  type ReservedStoreOperation,
  type ReservedStoreResults,
  type ScopeId,
  type StoreOperationCatalog,
  type StoreRequest,
  type StoreResponse,
  type TenantId,
} from '@substrat-run/contracts';
import { currentStoreCallSink, type StoreCallLine } from './invocation-line.js';
import type { HostAdmin } from './scope-host.js';

/** Who a scope-store object belongs to. The host builds it. The runner keys on it. */
export interface ScopeStoreAddress {
  readonly tenantId: string;
  readonly vertical: string;
  readonly scopeId: string;
  readonly binding: string;
}

/**
 * What a kind ships for the pure adapter and for tests (#2213). One runner per
 * kind. `invoke` speaks the envelope. `start` runs on the first store call.
 * `stop` runs from `close`, including when `start` never ran, so it tolerates that.
 */
export interface ScopeStoreRunner {
  readonly kind: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  invoke(address: ScopeStoreAddress, request: StoreRequest): Promise<StoreResponse>;
}

/** The runners a host was given, by binding. A binding named twice is refused. */
export interface ScopeStoreHostOptions {
  /** When set, a scope running any other vertical is refused. */
  readonly vertical?: string;
  readonly runners?: readonly { readonly binding: string; readonly runner: ScopeStoreRunner }[];
  readonly kinds?: Readonly<Record<string, string>>;
  /**
   * `platform` fetches `store.substrat.internal`. The router signs and addresses
   * the object. `binding` is the direct namespace, for local development and
   * tests, and is not an isolation boundary.
   */
  readonly transport?: 'platform' | 'binding';
}

export function scopeStoreRunnersOf(
  options: ScopeStoreHostOptions | undefined,
): Map<string, ScopeStoreRunner> {
  const runners = new Map<string, ScopeStoreRunner>();
  for (const entry of options?.runners ?? []) {
    if (runners.has(entry.binding)) {
      throw new Error(`scope store binding '${entry.binding}' is configured twice`);
    }
    runners.set(entry.binding, entry.runner);
  }
  return runners;
}

/** Starts and stops one host's runners (#2213). */
export interface ScopeStoreLifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * The lifecycle both adapters run their runners through. `start` starts each distinct
 * runner once, and concurrent callers share the pass. A runner that started stays
 * started when a later one throws, so the retry starts only the rest.
 *
 * `stop` first waits for a pass in flight, which starts no further runner once a stop
 * has begun (it rejects instead), so no runner is started after the stops are asked.
 * It then asks every runner, started or not, since a runner tolerates a stop without a
 * start. One that throws does not leave the others running. One failure is rethrown as
 * it is, and several as an `AggregateError` carrying each.
 */
export function scopeStoreLifecycleOf(runners: ReadonlyMap<string, ScopeStoreRunner>): ScopeStoreLifecycle {
  const started = new Set<ScopeStoreRunner>();
  let pending: Promise<void> | null = null;
  let stopping = false;
  return {
    start() {
      if (pending) return pending;
      const pass = (async () => {
        for (const runner of new Set(runners.values())) {
          if (started.has(runner)) continue;
          if (stopping) throw new Error('scope-store runners are stopping; this start is abandoned');
          await runner.start();
          started.add(runner);
        }
      })();
      pending = pass;
      pass.catch(() => {
        if (pending === pass) pending = null;
      });
      return pass;
    },
    async stop() {
      stopping = true;
      try {
        await pending?.catch(() => undefined);
        const failures: unknown[] = [];
        for (const runner of new Set(runners.values())) {
          try {
            await runner.stop();
          } catch (err) {
            failures.push(err);
          }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, `${failures.length} scope-store runners failed to stop`);
      } finally {
        started.clear();
        pending = null;
        stopping = false;
      }
    },
  };
}

/**
 * The capability a `getScopeStore` door returns (#2207).
 *
 * `invoke` takes an operation and its input. It does not take `InvokeOptions`:
 * those belong to a scope operation (idempotency, observers), and a store call
 * is not one. A third argument is refused at runtime as well as by this type.
 * The catalog parameter narrows `operation` for a caller who knows the kind.
 */
export interface StoreStub<C extends StoreOperationCatalog = StoreOperationCatalog> {
  readonly tenantId: TenantId;
  readonly scopeId: ScopeId;
  readonly subjectKind?: CheckSubject['kind'];
  invoke(operation: C['operations'][number], input?: unknown): Promise<unknown>;
}

/** What one store call leaves on an invocation line (#2245). Never the input. */
export type StoreCallReport = StoreCallLine;

/**
 * Observers on a store stub (#2245). They carry no authority, the same way
 * {@link ScopeStubOptions} does not. With none passed, the call is recorded on the
 * request now running (RFC §6); `onStoreCall`, when passed, is heard instead.
 * A throw from either is swallowed: the call's result is the store's, not the log's.
 */
export interface ScopeStoreStubOptions {
  readonly onStoreCall?: (report: StoreCallReport) => void;
}

/**
 * Refuse an operation name that is not a fixed label (RFC §6): no `@`, no
 * whitespace, no `:`, at most 64 characters. Checked before the call and before
 * any report, so a name built from input never reaches a line.
 */
function assertStoreOperationName(operation: unknown): asserts operation is string {
  if (!storeOperationName.safeParse(operation).success) {
    throw substratError(
      'validation_failed',
      `a store operation name is a fixed label: no @, no whitespace, no :, at most ${STORE_OPERATION_NAME_MAX} characters`,
    );
  }
}

/**
 * Time one store call and report it. The report names the binding, the
 * operation, the outcome and the duration. It is built here, from those four
 * facts, so a caller cannot put the input on it. A passed observer wins; with
 * none, the call goes to the request now running, and outside one it is not
 * logged.
 */
export async function observeStoreCall<T>(
  binding: string,
  operation: string,
  run: () => Promise<T>,
  onStoreCall?: (report: StoreCallReport) => void,
): Promise<T> {
  assertStoreOperationName(operation);
  // Resolved before the call: the record is the one of the request that made it.
  const sink = onStoreCall ?? currentStoreCallSink();
  const started = Date.now();
  try {
    const result = await run();
    noteStoreCall({ binding, operation, outcome: 'ok', durationMs: Date.now() - started }, sink);
    return result;
  } catch (err) {
    noteStoreCall({ binding, operation, outcome: 'error', durationMs: Date.now() - started }, sink);
    throw err;
  }
}

function noteStoreCall(report: StoreCallReport, sink?: (report: StoreCallReport) => void): void {
  try {
    sink?.(report);
  } catch {
    // Advisory. A broken observer must not replace the store's answer.
  }
}

/**
 * Send one envelope and read the answer (#2207). Reserved names are refused
 * here, before `send`, so the store never sees a `substrat.*` call from a
 * vertical. The platform's own caller does not come through this function.
 */
export async function callScopeStore(
  send: (request: StoreRequest) => Promise<unknown>,
  operation: string,
  input?: unknown,
  ...extra: unknown[]
): Promise<unknown> {
  if (extra.length > 0) {
    throw substratError('forbidden', 'a scope store invoke takes an operation and an input, and nothing else');
  }
  assertStoreOperationName(operation);
  if (operation.startsWith('substrat.')) {
    throw substratError('forbidden', `store operation '${operation}' is reserved for the platform`);
  }
  const request = storeRequest.parse({ operation, input });
  const parsed = storeResponse.safeParse(await send(request));
  if (!parsed.success) {
    throw new StoreError({ code: 'bad_envelope', status: 502, body: parsed.error.issues });
  }
  if ('error' in parsed.data) throw new StoreError(parsed.data.error);
  return parsed.data.result;
}

const RESERVED_RESULT = {
  'substrat.export': storeExportResult,
  'substrat.import': storeImportResult,
  'substrat.size': storeSizeResult,
  'substrat.wipe': storeWipeResult,
  'substrat.erase': storeEraseResult,
} as const satisfies { [O in ReservedStoreOperation]: { parse(value: unknown): ReservedStoreResults[O] } };

/** What a reserved operation answers, parsed (#2239). */
export type ReservedStoreResult<O extends ReservedStoreOperation> = ReservedStoreResults[O];

const reservedNames: readonly string[] = RESERVED_STORE_OPERATIONS;

function reservedInput(operation: ReservedStoreOperation, input: unknown): unknown {
  if (operation === 'substrat.import') {
    const parsed = storeImportInput.safeParse(input);
    if (!parsed.success) throw substratError('validation_failed', 'substrat.import takes { tables }');
    return parsed.data;
  }
  if (operation === 'substrat.erase') {
    const parsed = storeEraseInput.safeParse(input);
    if (!parsed.success) throw substratError('validation_failed', 'substrat.erase takes { subjectId }');
    return parsed.data;
  }
  if (input !== undefined) {
    throw substratError('validation_failed', `store operation '${operation}' takes no input`);
  }
  return undefined;
}

/**
 * The platform's caller (#2207). A name that is not reserved is refused before
 * `send`, the mirror of {@link callScopeStore}. The result is parsed against the
 * operation's schema, so a store that answers the wrong shape fails here, and the
 * caller gets that parsed type back rather than parsing again.
 */
export async function callReservedStoreOperation<O extends ReservedStoreOperation>(
  send: (request: StoreRequest) => Promise<unknown>,
  operation: O,
  input?: unknown,
): Promise<ReservedStoreResult<O>> {
  if (!reservedNames.includes(operation)) {
    throw substratError('forbidden', `store operation '${operation}' is not reserved for the platform`);
  }
  const request = storeRequest.parse({ operation, input: reservedInput(operation, input) });
  const parsed = storeResponse.safeParse(await send(request));
  if (!parsed.success) {
    throw new StoreError({ code: 'bad_envelope', status: 502, body: parsed.error.issues });
  }
  if ('error' in parsed.data) throw new StoreError(parsed.data.error);
  const result = RESERVED_RESULT[operation].safeParse(parsed.data.result);
  if (!result.success) {
    throw new StoreError({ code: 'bad_envelope', status: 502, body: result.error.issues });
  }
  return result.data as ReservedStoreResult<O>;
}

/**
 * What a restore's erasure replay did (#2207). Present only when there is something to report:
 * `storeErasuresReplayed > 0` or `storeErasureIncomplete`. Absent means no erasure had to be
 * replayed and none is missing (no store for the target scope on this host, or no tombstone
 * that applies).
 *
 * `storeErasureIncomplete` means some tombstone that applies to the restored data was not
 * re-erased here. Either a store call failed, which the same restore again converges, or
 * `storeErasureSourceUnknown`: the dump's source scope is not a scope of this tenant on this
 * host (another host's backup, another tenant's, a deleted snapshot), so its marks cannot
 * be read and running the restore again does not change that.
 */
export interface StoreErasureReplay {
  storeErasuresReplayed: number;
  storeErasureIncomplete: boolean;
  storeErasureSourceUnknown?: true;
}

/**
 * `substrat.erase` again for every subject tombstoned in the target or in the dump's source
 * (#2207). The target's marks always apply: the data now lives there. The source's apply
 * when this host knows the source; a reaped scope keeps its directory row and its marks, so
 * it is known. An unknown source never refuses the restore: it is reported. Each subject is
 * erased once, and `erase` returns how many bindings it called.
 */
export async function replayStoreErasures(input: {
  admin: Pick<HostAdmin, 'listShreddedSubjects'>;
  actor: PlatformActorId;
  tenantId: TenantId;
  target: ScopeId;
  source: ScopeId;
  erase: (subjectId: string) => Promise<number>;
}): Promise<StoreErasureReplay | undefined> {
  const { admin, actor, tenantId } = input;
  const subjects = new Set<string>();
  const collect = async (scope: ScopeId): Promise<void> => {
    let cursor: string | undefined;
    for (;;) {
      const page = await admin.listShreddedSubjects(actor, tenantId, scope, cursor);
      for (const subject of page.subjects) subjects.add(subject);
      if (!page.nextCursor) return;
      cursor = page.nextCursor;
    }
  };
  await collect(input.target);
  let sourceUnknown = false;
  if (input.source !== input.target) {
    try {
      await collect(input.source);
    } catch (e) {
      if (errorCodeOf(e) !== 'not_found') throw e;
      sourceUnknown = true;
    }
  }
  let replayed = 0;
  let failed = false;
  for (const subject of subjects) {
    try {
      replayed += await input.erase(subject);
    } catch {
      failed = true;
    }
  }
  if (replayed === 0 && !failed && !sourceUnknown) return undefined;
  return {
    storeErasuresReplayed: replayed,
    storeErasureIncomplete: failed || sourceUnknown,
    ...(sourceUnknown ? { storeErasureSourceUnknown: true as const } : {}),
  };
}
