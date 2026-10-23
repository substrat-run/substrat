/**
 * The wire-signing verifier in the platform's entry module (RFC wire-signing §5, step 1, Q2).
 *
 * `tools/platform-entry-emit.mts` wraps the stamp (`withInvocationLog`'s output) with this, so a
 * request is judged before anything of the vertical's runs and the vertical sees exactly one
 * identity. Bundled into the entry, never emitted on its own: like `store-entry/`, it imports only
 * zero-import contracts subpaths.
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
 * an envelope alone proves is served as the envelope says. One that neither proves goes on as it
 * came, and the vertical's own checks refuse it as they do now. A fault of the version's own (a
 * key list that will not load, no nonce store) is counted and handed on the same way. In
 * `signed-only` the envelope alone decides, and every refusal is the same answer.
 *
 * Every judged request writes one `{ substrat: 'wire' }` line (contracts'
 * `WireVerificationLine`), beside the invocation line and sharing its request id.
 */
import { assertPlatformCall } from '@substrat-run/contracts/wire-auth';
import { PLATFORM_SECRET_HEADER } from '@substrat-run/contracts/wire-headers';
import {
  decodeWireEnvelope,
  verifyWireEnvelope,
  WIRE_AUDIENCE_VAR,
  WIRE_ENVELOPE_HEADER,
  WIRE_PLATFORM_KEYS_VAR,
  WIRE_ROUTER_KEYS_VAR,
  WIRE_STATE_VAR,
  wireEndpoint,
  wireReplayOf,
  wireRequestBinding,
  wireStateOf,
  wireVerificationKeys,
  type WireClaims,
  type WireExpectation,
  type WireFault,
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
   * `no-nonce-store` fault. It is reached only when the nonce is claimed, after every other check
   * has passed, and for the scope the verified envelope names. An answer of `undefined` says this
   * version has no store for it: the same static fault as no seam at all (RFC §3.4), except that a
   * claim that would come too late is refused as `claim-after-until` first (RFC §4), since the
   * verifier reads its claim clock before the seam is asked. A throw is the store's failure.
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

/**
 * The module-worker shape the gate wraps: the stamp's output, a plain object whose other handlers
 * (`scheduled`, `queue`, …) are already its own properties, bound to the vertical's worker.
 */
export interface GatedWorker<Env> {
  fetch?: (request: Request, env: Env, ctx: unknown) => unknown;
  [handler: string]: unknown;
}

/**
 * The one refusal, for every reason (RFC §3.4), and the one answer to every fault. Fixed text,
 * `problemForStatus`'s shape: a test holds both to it.
 */
export const WIRE_REFUSAL_BODY = '{"type":"about:blank","title":"Unauthorized","status":401,"detail":"unauthorized","error":"unauthorized"}';
export const WIRE_FAULT_BODY =
  '{"type":"about:blank","title":"Service unavailable","status":503,"detail":"this request could not be verified","error":"this request could not be verified"}';
const problem = (body: string, status: number) => new Response(body, { status, headers: { 'content-type': 'application/problem+json' } });

/** The prefix the router strips from every inbound request before it asserts its own headers. */
const ASSERTED_PREFIX = 'x-substrat-';
/** The identity headers the router asserts, and its credential beside them. */
const TENANT = 'x-substrat-tenant';
const SCOPE = 'x-substrat-scope';
const SURFACE = 'x-substrat-surface';
const VERTICAL = 'x-substrat-vertical';
const ROUTER_CREDENTIAL = 'x-substrat-router';

/** The deployment's own fault, by kind. Thrown inside the gate, never past it. */
class GateFault extends Error {
  constructor(readonly fault: WireFault) {
    super(fault);
  }
}

/**
 * The store a call claims through, reached only when the verifier claims: a claim is its last
 * check, after the signature and the scope pin, so nothing is asked of the store for an envelope
 * refused for anything else. A seam that answers with no store is the static `no-nonce-store`
 * (RFC §3.4): this version has none, which is a fact about it, not a failure of the request. A store
 * that exists is bounded in time, and a throw (reaching it included) or a timeout is its failure.
 */
function claimedThrough(reach: () => WireNonceCache | undefined, timeoutMs: number): WireNonceCache {
  return {
    async claim(nonce, until) {
      let cache: WireNonceCache | undefined;
      try {
        cache = reach();
      } catch {
        throw new GateFault('nonce-store');
      }
      // `== null`: an untyped `null` says the same as `undefined`, as it did when the seam was read up front.
      if (cache == null) throw new GateFault('no-nonce-store');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          cache.claim(nonce, until),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('the nonce store did not answer in time')), timeoutMs);
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

/** The legacy credential on a request, judged with the answers the vertical gives its own checks. */
function legacyOf<Env>(request: Request, call: boolean, env: Env, options: WireGateOptions<Env>): Legacy {
  if (call) {
    let credential: WireLegacyCredential = request.headers.has(PLATFORM_SECRET_HEADER) ? 'invalid' : 'absent';
    try {
      assertPlatformCall(request.headers, { expectedSecret: options.platformSecret(env) });
      credential = 'valid';
    } catch {
      /* not a valid platform call */
    }
    return { credential, identity: null };
  }
  try {
    const node = options.routedNode(request.headers, env);
    return node ? { credential: 'valid', identity: node } : { credential: 'absent', identity: null };
  } catch {
    return { credential: 'invalid', identity: null };
  }
}

const sameIdentity = (legacy: RoutedIdentity, claims: WireClaims) =>
  legacy.tenantId === claims.tenantId &&
  legacy.scopeId === claims.scopeId &&
  legacy.surface === claims.surface &&
  legacy.verticalSlug === claims.vertical;

/** The tenant and scope a request was served as, for its line. */
const servedAs = (who: { readonly tenantId: string | null; readonly scopeId: string | null } | null) => ({
  tenantId: who?.tenantId ?? null,
  scopeId: who?.scopeId ?? null,
});

/**
 * Wrap the stamp's `fetch` with the verifier. Its other handlers pass through as they are, and a
 * worker with no `fetch` (a class entrypoint) comes back untouched, as `withInvocationLog` does:
 * such a version carries the entry but verifies nothing, and RFC Q2 and §7 name it as not ready.
 */
export function withWireGate<Env>(worker: GatedWorker<Env>, options: WireGateOptions<Env>): GatedWorker<Env> {
  const inner = (worker as GatedWorker<Env> | undefined)?.fetch;
  if (typeof inner !== 'function') return worker;
  const clock = options.clock ?? Date.now;
  const seconds = () => Math.floor(clock() / 1000);
  const timeoutMs = options.claimTimeoutMs ?? WIRE_CLAIM_TIMEOUT_MS;
  const log = options.log ?? ((line: string) => console.log(line));
  const serve = (request: Request, env: Env, ctx: unknown) => inner.call(worker, request, env, ctx);

  async function judged(request: Request, env: Env, ctx: unknown, state: Exclude<WireState, 'legacy-only'>): Promise<unknown> {
    // When the request arrived: the envelope's window is judged against this, not body time.
    const nowSeconds = seconds();
    const e = env as Record<string, unknown>;
    const aud = textOf(e[WIRE_AUDIENCE_VAR]);
    const { method, target } = wireRequestBinding(request);
    const pathname = new URL(request.url).pathname;
    const endpoint = wireEndpoint(pathname);
    const call = endpoint.kind === 'call';
    // Read before it is verified, only to choose which issuer to judge a call as and which scope's
    // store a nonce would be claimed in. The verifier checks both against the signed bytes.
    const claimed = call ? decodeWireEnvelope(request.headers.get(WIRE_ENVELOPE_HEADER) ?? '')?.claims : undefined;
    const issuer = claimed && endpoint.issuers.includes(claimed.iss) ? claimed.iss : endpoint.issuers[0]!;
    /** The envelope's claims, once verified: until then nothing on the line is taken from it. */
    let claims: WireClaims | undefined;

    const line = (outcome: WireOutcome, legacy: WireLegacyCredential, extra: Partial<WireVerificationLine> = {}) => {
      const v = e['SUBSTRAT_VERSION_ID'];
      const record: WireVerificationLine = {
        substrat: 'wire',
        state,
        issuer: claims?.iss ?? (endpoint.issuers.length === 1 ? endpoint.issuers[0]! : null),
        kind: endpoint.kind,
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
      return problem(WIRE_FAULT_BODY, 503);
    };

    const legacy = legacyOf(request, call, env, options);
    let downstream = request;
    /**
     * A fault that is a fact about this version or its settings, not a failure of this request: a
     * key list that will not load, or no nonce store for a call that needs one. `dual` refuses
     * nothing new, so it counts the fault and hands the request on as it came: a valid legacy
     * credential is served as today, and anything else meets the vertical's own checks. Counted, it
     * still keeps the version from passing the gate on `signed-only`, where there is no legacy path
     * to hand it to, so the fault is answered.
     */
    const staticFault = (fault: WireFault, extra: Partial<WireVerificationLine> = {}) => {
      if (state !== 'dual') return faulted(fault, legacy.credential);
      line('fault', legacy.credential, { fault, ...extra });
      return serve(downstream, env, ctx);
    };

    let keys: WireVerificationKeys;
    try {
      keys = await keysFor(textOf(e[WIRE_ROUTER_KEYS_VAR]), textOf(e[WIRE_PLATFORM_KEYS_VAR]));
    } catch {
      return staticFault('keys', servedAs(legacy.identity));
    }

    // A call binds its exact body (RFC §3.6). It is read whole, and only when the verifier reaches
    // it, after the signature, the audience, the time, the method and the target: a call that
    // carries no envelope, or one refused for any of those, is handed on with its body unread. One that is read hands the vertical
    // the same bytes.
    const readBody = async (): Promise<ArrayBuffer | string | null> => {
      if (request.body === null) return '';
      let body: ArrayBuffer;
      try {
        body = await request.arrayBuffer();
      } catch {
        // The caller's body did not arrive: refused as `body`, never digested as empty.
        return null;
      }
      downstream = new Request(request, { body });
      return body;
    };

    // A call's replay policy is its endpoint's (RFC §4), never inferred from the envelope. One that
    // keeps nonces spends its nonce in the store of the scope it names, so it pins that scope. With
    // no scope named, or no store, it is verified in full and then counted as this version's fault.
    // The store is reached only at the claim: by then the verifier has held the signed scope to the
    // pin, so `pinned` is the scope the verified envelope names, never only the unverified one's.
    const keepsNonces = call && wireReplayOf(method, pathname) === 'nonce';
    const pinned = keepsNonces ? (claimed?.scopeId ?? undefined) : undefined;
    const reach = options.nonceCache;
    const store = pinned !== undefined && reach ? claimedThrough(() => reach(env, pinned), timeoutMs) : undefined;
    const expected: WireExpectation = call
      ? {
          iss: issuer,
          kind: 'call',
          aud,
          method,
          target,
          body: readBody,
          replay: store ?? 'none',
          scopeId: store ? pinned : undefined,
        }
      : { iss: 'router', kind: 'route', aud, method, target };

    let reason: WireRefusalReason | null = null;
    /** The seam answered, at the claim, that this version has no store. */
    let noStore = !store;
    try {
      const verdict = await verifyWireEnvelope({
        headers: request.headers,
        keys,
        expected,
        nowSeconds,
        clockSeconds: seconds,
        onRefusal: (why) => {
          reason = why;
        },
      });
      if (verdict.ok) claims = verdict.claims;
    } catch (error) {
      if (error instanceof GateFault && error.fault === 'no-nonce-store') {
        // The seam answered that this version has no store. It is asked only at the claim, the
        // verifier's last check, so the envelope passed every other: its decoded claims (the same
        // header the verifier decoded) are the verified ones, and the fault is the static one below.
        claims = claimed;
        noStore = true;
      } else {
        // A store that exists and fails is the platform's failure in every state.
        return faulted(error instanceof GateFault ? error.fault : 'verifier', legacy.credential);
      }
    }
    // An envelope that passed everything else, on a call that keeps nonces with no store to keep
    // them in: a static fault, reached only now, as a claim is always the last check.
    if (claims && keepsNonces && noStore) {
      return staticFault('no-nonce-store', servedAs(legacy.identity ?? claims));
    }

    // Two valid credentials naming different requests: a router defect to count in every state (Q9),
    // whichever of them decides what is served.
    const mismatched = !!claims && !!legacy.identity && !sameIdentity(legacy.identity, claims);
    if (state === 'dual' && legacy.credential === 'valid') {
      // Served exactly as today, as the legacy credential says; the envelope is only counted.
      const outcome: WireOutcome = !claims ? 'legacy-accepted' : mismatched ? 'dual-mismatch' : 'signed-accepted';
      line(outcome, 'valid', { reason, ...servedAs(legacy.identity ?? claims ?? null) });
      return serve(downstream, env, ctx);
    }
    if (!claims) {
      line('refused', legacy.credential, { reason });
      // `dual` refuses nothing new: the vertical's own checks answer it, exactly as they do today.
      if (state === 'dual') return serve(downstream, env, ctx);
      return problem(WIRE_REFUSAL_BODY, 401);
    }
    // The envelope alone admits it, in `dual` (no valid legacy credential beside it) or in
    // `signed-only`: the vertical is handed the identity the envelope proved, and no other.
    let proven: Request;
    try {
      proven = provenAs(downstream, claims, env, options);
    } catch {
      return faulted('verifier', legacy.credential);
    }
    line(mismatched ? 'dual-mismatch' : 'signed-accepted', legacy.credential, servedAs(claims));
    return serve(proven, env, ctx);
  }

  return {
    ...worker,
    fetch(request: Request, env: Env, ctx: unknown) {
      const state = stateOf(env);
      // The same request, and whatever the vertical returns, with nothing in between.
      if (state === 'legacy-only') return serve(request, env, ctx);
      return judged(request, env, ctx, state);
    },
  };
}

/**
 * The request as the vertical is to see it when the envelope alone admitted it: carrying the
 * identity the envelope proved, in the form every version of the vertical's own checks reads, and
 * nothing else under the prefix the router reserves. Every inbound `x-substrat-*` header goes, in
 * any letter case and however often it was sent, so no header the envelope did not sign reaches
 * the vertical as the platform's word.
 */
function provenAs<Env>(request: Request, claims: WireClaims, env: Env, options: WireGateOptions<Env>): Request {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) if (name.startsWith(ASSERTED_PREFIX)) headers.delete(name);
  const put = (name: string, value: string | null | undefined) => {
    if (value) headers.set(name, value);
  };
  if (claims.kind === 'route') {
    put(TENANT, claims.tenantId);
    put(SCOPE, claims.scopeId);
    put(SURFACE, claims.surface);
    put(VERTICAL, claims.vertical);
    put(ROUTER_CREDENTIAL, options.routerSecret(env));
  } else {
    put(VERTICAL, claims.vertical);
    put(PLATFORM_SECRET_HEADER, options.platformSecret(env));
  }
  return new Request(request, { headers });
}
