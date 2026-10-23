/**
 * The wire-signing verifier in the platform's entry module (RFC wire-signing §5, step 1, Q2).
 *
 * `tools/platform-entry-emit.mts` wraps the vertical's default export with this, outside the
 * invocation stamp, so a request is judged before anything of the vertical's runs and the
 * vertical sees exactly one identity. Bundled into the entry, never emitted on its own: like
 * `store-entry/`, it imports only zero-import contracts subpaths.
 *
 * **Inert until a deployment is given key lists.** With none, or with the state set to
 * `legacy-only`, `fetch` hands the very request it was given to the vertical and returns
 * whatever the vertical returned: three settings are read, and nothing of the request is read,
 * awaited or logged. That is every deployment today, since no upload injects keys yet (RFC §9,
 * step 2).
 *
 * In `dual` the gate refuses nothing the legacy credentials admit. A request whose legacy
 * credential is valid is served exactly as today, and its envelope is only counted: accepted,
 * refused for a reason, or a disagreement between the two on who the request is for. One that
 * an envelope alone proves is served as the envelope says. One that neither proves goes on
 * untouched, and the vertical's own checks refuse it as they do now. In `signed-only` the
 * envelope alone decides, and every refusal is the same answer.
 *
 * Every judged request writes one `{ substrat: 'wire' }` line (contracts'
 * `WireVerificationLine`), beside the invocation line and sharing its request id.
 */
import { base64UrlToBytes } from '@substrat-run/contracts/scope-store-envelope';
import { assertPlatformCall } from '@substrat-run/contracts/wire-auth';
import { PLATFORM_SECRET_HEADER } from '@substrat-run/contracts/wire-headers';
import {
  parseWireEnvelope,
  verifyWireEnvelope,
  WIRE_AUDIENCE_VAR,
  WIRE_ENVELOPE_HEADER,
  WIRE_PLATFORM_KEYS_VAR,
  WIRE_ROUTER_KEYS_VAR,
  WIRE_STATE_VAR,
  wireRequestBinding,
  wireStateOf,
  wireVerificationKeys,
  type WireClaims,
  type WireExpectation,
  type WireFault,
  type WireIssuer,
  type WireLegacyCredential,
  type WireNonceCache,
  type WireOutcome,
  type WireRefusalReason,
  type WireState,
  type WireVerificationKeys,
  type WireVerificationLine,
} from '@substrat-run/contracts/wire-signing';

/** The identity the router asserts on a routed request: vertical-host's `RoutedNode`, structurally. */
export interface RoutedIdentity {
  readonly tenantId: string;
  readonly scopeId: string;
  readonly surface: string;
  readonly verticalSlug: string | null;
}

export interface WireGateOptions<Env> {
  /**
   * The legacy check on a routed request, with the answers the vertical gives its own: `null`
   * when the request asserts no identity, a throw when it asserts one that does not verify.
   * The entry passes vertical-host's `readRoutedNode`.
   */
  readonly routedNode: (headers: Headers, env: Env) => RoutedIdentity | null;
  /** The router's legacy credential as this deployment holds it. */
  readonly routerSecret: (env: Env) => string | undefined;
  /** The platform's legacy call credential as this deployment holds it. */
  readonly platformSecret: (env: Env) => string | undefined;
  /**
   * Where a call that changes state spends its nonce: the scope object's store (RFC §4, Q4), a
   * follow-on. Until one is given, such a call cannot be verified, and is counted as the
   * `no-nonce-store` fault.
   */
  readonly nonceCache?: (env: Env, scopeId: string) => WireNonceCache | undefined;
  /** Milliseconds since the epoch. The wall clock unless a test injects one. */
  readonly clock?: () => number;
  /** How long a nonce claim may take before it counts as the store's failure. */
  readonly claimTimeoutMs?: number;
  /** Where the wire line goes. `console.log` unless a test injects one. */
  readonly log?: (line: string) => void;
}

/** RFC §4: a claim that has not settled in this long is the store's failure, answered as one. */
export const WIRE_CLAIM_TIMEOUT_MS = 1000;

/** The module-worker shape the gate wraps, structurally, as `withInvocationLog` takes it. */
export interface GatedWorker<Env> {
  fetch?: (request: Request, env: Env, ctx: unknown) => unknown;
  [handler: string]: unknown;
}

/** The handlers a module worker may export besides `fetch`, passed through untouched: `withInvocationLog`'s list. */
const OTHER_HANDLERS = ['scheduled', 'queue', 'email', 'tail', 'trace', 'alarm', 'test'] as const;

const PROBLEM = 'application/problem+json';
/**
 * The one refusal, for every reason (RFC §3.4), and the one answer to every fault. Fixed text,
 * `problemForStatus`'s shape: a test holds both to it.
 */
export const WIRE_REFUSAL_BODY = '{"type":"about:blank","title":"Unauthorized","status":401,"detail":"unauthorized","error":"unauthorized"}';
export const WIRE_FAULT_BODY =
  '{"type":"about:blank","title":"Service unavailable","status":503,"detail":"this request could not be verified","error":"this request could not be verified"}';

/** The identity headers the router asserts, and its credential beside them. */
const TENANT = 'x-substrat-tenant';
const SCOPE = 'x-substrat-scope';
const SURFACE = 'x-substrat-surface';
const VERTICAL = 'x-substrat-vertical';
const ROUTER_CREDENTIAL = 'x-substrat-router';

/** The internal surface `mountPlatformSurface` gates, as its `/internal/*` matches it. */
const isInternal = (pathname: string) => pathname === '/internal' || pathname.startsWith('/internal/');
/** The one internal endpoint the router calls as well as the control plane: a peer invocation. */
const PEER_INVOKE = '/internal/vertical-invoke';
/** RFC §4: a call that changes state keeps nonces; these do not change state. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The deployment's own fault, by kind. Thrown inside the gate, never past it. */
class GateFault extends Error {
  constructor(readonly fault: WireFault) {
    super(fault);
  }
}

/** A call that needs a nonce store, on a deployment that has none: found only when the claim is due. */
const NO_NONCE_STORE: WireNonceCache = {
  claim() {
    throw new GateFault('no-nonce-store');
  },
};

/** The store a call claims through, bounded in time, with a throw or a timeout read as the store's failure. */
function boundedCache(cache: WireNonceCache, timeoutMs: number): WireNonceCache {
  return {
    async claim(nonce, until) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          Promise.resolve().then(() => cache.claim(nonce, until)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new GateFault('nonce-store')), timeoutMs);
          }),
        ]);
      } catch {
        throw new GateFault('nonce-store');
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** One isolate's key set, built once per configured pair of lists. */
let builtKeys: { readonly text: string; readonly keys: Promise<WireVerificationKeys> } | undefined;
function keysFor(router: string, platform: string): Promise<WireVerificationKeys> {
  const text = `${router}\n${platform}`;
  if (builtKeys?.text !== text) builtKeys = { text, keys: wireVerificationKeys({ router, platform }) };
  return builtKeys.keys;
}

const textOf = (value: unknown) => (typeof value === 'string' ? value : '');

/** The state this deployment's settings name, read synchronously so `legacy-only` costs nothing. */
function stateOf(env: unknown): WireState {
  const e = (env ?? {}) as Record<string, unknown>;
  return wireStateOf({ routerKeys: e[WIRE_ROUTER_KEYS_VAR], platformKeys: e[WIRE_PLATFORM_KEYS_VAR], state: e[WIRE_STATE_VAR] });
}

/** What the legacy credential beside the envelope proved. */
type Legacy = { readonly credential: WireLegacyCredential; readonly identity: RoutedIdentity | null };

/**
 * The claims an envelope header names, read before it is verified, only to choose which issuer
 * to judge it as and which scope's store a nonce would be claimed in. The verifier then checks
 * both against the signed bytes, so nothing read here is trusted.
 */
function peek(headers: Headers): WireClaims | undefined {
  const bytes = base64UrlToBytes(headers.get(WIRE_ENVELOPE_HEADER) ?? '');
  if (!bytes) return undefined;
  try {
    return parseWireEnvelope(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

const sameIdentity = (legacy: RoutedIdentity, claims: WireClaims) =>
  legacy.tenantId === claims.tenantId &&
  legacy.scopeId === claims.scopeId &&
  legacy.surface === claims.surface &&
  legacy.verticalSlug === claims.vertical;

/**
 * Wrap a module worker's `fetch` with the verifier. Other handlers pass through, bound to the
 * worker, and a worker with no `fetch` comes back untouched, as `withInvocationLog` does.
 */
export function withWireGate<Env>(worker: GatedWorker<Env>, options: WireGateOptions<Env>): GatedWorker<Env> {
  const inner = (worker as GatedWorker<Env> | undefined)?.fetch;
  if (typeof inner !== 'function') return worker;
  const clock = options.clock ?? Date.now;
  const timeoutMs = options.claimTimeoutMs ?? WIRE_CLAIM_TIMEOUT_MS;
  const log = options.log ?? ((line: string) => console.log(line));
  const serve = (request: Request, env: Env, ctx: unknown) => inner.call(worker, request, env, ctx);

  async function judged(request: Request, env: Env, ctx: unknown, state: Exclude<WireState, 'legacy-only'>): Promise<unknown> {
    // When the request arrived: the envelope's window is judged against this, not body time.
    const nowSeconds = Math.floor(clock() / 1000);
    const e = env as Record<string, unknown>;
    const { method, target } = wireRequestBinding(request);
    const pathname = new URL(request.url).pathname;
    const call = isInternal(pathname);
    const claimed = peek(request.headers);
    const admitted: readonly WireIssuer[] = !call ? ['router'] : pathname === PEER_INVOKE ? ['platform', 'router'] : ['platform'];
    const issuer = claimed && admitted.includes(claimed.iss) ? claimed.iss : admitted[0]!;

    const line = (outcome: WireOutcome, legacy: WireLegacyCredential, extra: Partial<WireVerificationLine> = {}) => {
      const v = e['SUBSTRAT_VERSION_ID'];
      const record: WireVerificationLine = {
        substrat: 'wire',
        state,
        issuer,
        kind: call ? 'call' : 'route',
        outcome,
        reason: null,
        fault: null,
        legacy,
        tenantId: null,
        scopeId: null,
        versionId: typeof v === 'string' && v.length > 0 ? v : null,
        ...extra,
      };
      try {
        log(JSON.stringify(record));
      } catch {
        /* a counter is never a failed request */
      }
    };
    const faulted = (fault: WireFault, legacy: WireLegacyCredential) => {
      line('fault', legacy, { fault });
      return new Response(WIRE_FAULT_BODY, { status: 503, headers: { 'content-type': PROBLEM } });
    };

    // The legacy credential, judged with the vertical's own answers.
    let legacy: Legacy;
    if (call) {
      const presented = request.headers.get(PLATFORM_SECRET_HEADER) !== null;
      let valid = false;
      try {
        assertPlatformCall(request.headers, { expectedSecret: options.platformSecret(env) });
        valid = true;
      } catch {
        /* not a valid platform call */
      }
      legacy = { credential: valid ? 'valid' : presented ? 'invalid' : 'absent', identity: null };
    } else {
      try {
        const node = options.routedNode(request.headers, env);
        legacy = node ? { credential: 'valid', identity: node } : { credential: 'absent', identity: null };
      } catch {
        legacy = { credential: 'invalid', identity: null };
      }
    }

    let keys: WireVerificationKeys;
    try {
      keys = await keysFor(textOf(e[WIRE_ROUTER_KEYS_VAR]), textOf(e[WIRE_PLATFORM_KEYS_VAR]));
    } catch {
      return faulted('keys', legacy.credential);
    }

    // A call binds its exact body (RFC §3.6), so the body is read whole before anything acts on
    // it, and the vertical is handed the same bytes.
    let body: ArrayBuffer | undefined;
    let downstream = request;
    if (call && request.body !== null) {
      body = await request.arrayBuffer();
      downstream = new Request(request, { body });
    }

    // A call that changes state spends its nonce in the scope's own store, so it pins that scope.
    // One that names no scope has no store to spend it in, and is held to its window alone.
    const pinned = call && !SAFE_METHODS.has(method) ? (claimed?.scopeId ?? undefined) : undefined;
    const store = pinned === undefined ? undefined : (options.nonceCache?.(env, pinned) ?? undefined);
    const expected: WireExpectation = call
      ? {
          iss: issuer,
          kind: 'call',
          aud: textOf(e[WIRE_AUDIENCE_VAR]),
          method,
          target,
          body: body ?? '',
          replay: pinned === undefined ? 'none' : store ? boundedCache(store, timeoutMs) : NO_NONCE_STORE,
          ...(pinned === undefined ? {} : { scopeId: pinned }),
        }
      : { iss: 'router', kind: 'route', aud: textOf(e[WIRE_AUDIENCE_VAR]), method, target };

    let reason: WireRefusalReason | null = null;
    let claims: WireClaims | undefined;
    try {
      const verdict = await verifyWireEnvelope({
        headers: request.headers,
        keys,
        expected,
        nowSeconds,
        clockSeconds: () => Math.floor(clock() / 1000),
        onRefusal: (why) => {
          reason = why;
        },
      });
      if (verdict.ok) claims = verdict.claims;
    } catch (error) {
      const fault = error instanceof GateFault ? error.fault : 'verifier';
      // A store this version does not have is a fact about the version, not a failure of this
      // request: `dual` still serves what the legacy credential proves, and the fault is counted,
      // which keeps the version from passing the gate on `signed-only`. A store that exists and
      // fails is the platform's failure in every state.
      if (fault === 'no-nonce-store' && state === 'dual' && legacy.credential === 'valid') {
        line('fault', 'valid', { fault, ...served(legacy.identity, null) });
        return serve(downstream, env, ctx);
      }
      return faulted(fault, legacy.credential);
    }

    if (state === 'dual' && legacy.credential === 'valid') {
      // Served exactly as today, as the legacy credential says; the envelope is only counted.
      const outcome: WireOutcome = !claims
        ? 'legacy-accepted'
        : legacy.identity && !sameIdentity(legacy.identity, claims)
          ? 'dual-mismatch'
          : 'signed-accepted';
      line(outcome, 'valid', { reason: claims ? null : reason, ...served(legacy.identity, claims ?? null) });
      return serve(downstream, env, ctx);
    }
    if (!claims) {
      line('refused', legacy.credential, { reason });
      // `dual` refuses nothing new: the vertical's own checks answer it, exactly as they do today.
      if (state === 'dual') return serve(downstream, env, ctx);
      return new Response(WIRE_REFUSAL_BODY, { status: 401, headers: { 'content-type': PROBLEM } });
    }
    // The envelope alone admits it, in `dual` (no valid legacy credential beside it) or in
    // `signed-only`: the vertical is handed the identity the envelope proved, and no other.
    line('signed-accepted', legacy.credential, served(null, claims));
    return serve(provenAs(downstream, claims, env, options), env, ctx);
  }

  const gated: GatedWorker<Env> = {
    fetch(request: Request, env: Env, ctx: unknown) {
      const state = stateOf(env);
      // The same request, and whatever the vertical returns, with nothing in between.
      if (state === 'legacy-only') return serve(request, env, ctx);
      return judged(request, env, ctx, state);
    },
  };
  for (const name of OTHER_HANDLERS) {
    const h = worker[name];
    if (typeof h === 'function') gated[name] = (h as (...a: unknown[]) => unknown).bind(worker);
  }
  return gated;
}

/** The tenant and scope a request was served as, for its line: the legacy identity, else the envelope's. */
function served(identity: RoutedIdentity | null, claims: WireClaims | null): Pick<WireVerificationLine, 'tenantId' | 'scopeId'> {
  if (identity) return { tenantId: identity.tenantId, scopeId: identity.scopeId };
  return { tenantId: claims?.tenantId ?? null, scopeId: claims?.scopeId ?? null };
}

/**
 * The request as the vertical is to see it when the envelope alone admitted it: carrying the
 * identity the envelope proved, in the form every version of the vertical's own checks reads.
 */
function provenAs<Env>(request: Request, claims: WireClaims, env: Env, options: WireGateOptions<Env>): Request {
  const headers = new Headers(request.headers);
  if (claims.kind === 'route') {
    headers.set(TENANT, claims.tenantId!);
    headers.set(SCOPE, claims.scopeId!);
    headers.set(SURFACE, claims.surface!);
    if (claims.vertical === null) headers.delete(VERTICAL);
    else headers.set(VERTICAL, claims.vertical);
    const secret = options.routerSecret(env);
    if (secret) headers.set(ROUTER_CREDENTIAL, secret);
    else headers.delete(ROUTER_CREDENTIAL);
  } else {
    const secret = options.platformSecret(env);
    if (secret) headers.set(PLATFORM_SECRET_HEADER, secret);
    else headers.delete(PLATFORM_SECRET_HEADER);
  }
  return new Request(request, { headers });
}
