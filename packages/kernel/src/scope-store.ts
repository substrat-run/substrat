import {
  StoreError,
  storeRequest,
  storeResponse,
  substratError,
  type CheckSubject,
  type ScopeId,
  type StoreOperationCatalog,
  type StoreRequest,
  type StoreResponse,
  type TenantId,
} from '@substrat-run/contracts';

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
  readonly runners: readonly { readonly binding: string; readonly runner: ScopeStoreRunner }[];
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
 * started when a later one throws, so the retry starts only the rest. `stop` asks every
 * runner, started or not, since a runner tolerates a stop without a start. One that
 * throws does not leave the others running: the first error is rethrown once all have
 * been asked.
 */
export function scopeStoreLifecycleOf(runners: ReadonlyMap<string, ScopeStoreRunner>): ScopeStoreLifecycle {
  const started = new Set<ScopeStoreRunner>();
  let pending: Promise<void> | null = null;
  return {
    start() {
      if (pending) return pending;
      const pass = (async () => {
        for (const runner of new Set(runners.values())) {
          if (started.has(runner)) continue;
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
      const failures: unknown[] = [];
      for (const runner of new Set(runners.values())) {
        try {
          await runner.stop();
        } catch (err) {
          failures.push(err);
        }
      }
      started.clear();
      pending = null;
      if (failures.length > 0) throw failures[0];
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
