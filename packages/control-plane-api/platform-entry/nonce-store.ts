/**
 * Where the platform's entry spends a signed call's nonce (RFC wire-signing §4): the scope's own
 * object, reached through the scope host the vertical's bundle registered.
 *
 * The scope object is the vertical's own class, bound under a name of the vertical's choosing, so
 * the entry cannot reach it by itself. Every deployed vertical already hands its host to
 * `mountPlatformSurface`, which registers it for the platform's sweeper (#1902, vertical-host's
 * `registeredScopeSweepHost`), and that same host is what a call's handler reaches the scope
 * through. So the entry asks it: `claimWireNonceLocal`, which a current adapter has. A bundle that
 * registers no host (a vertical-host before #1902), or whose host has no such method (an adapter
 * before the store), answers `undefined`: this version has no nonce store, the static fault RFC
 * §3.4 counts.
 *
 * Bundled into the entry, never emitted on its own. The registry reader is passed in by
 * `tools/platform-entry-emit.mts`, so this file imports only types.
 */
import type { WireNonceCache } from '@substrat-run/contracts/wire-signing';

/** vertical-host's `registeredScopeSweepHost`: the host builder the bundle registered, if any. */
export type RegisteredHost = () => ((env: never) => unknown) | undefined;

/** The slice of a scope host the claim calls: both adapters' `claimWireNonceLocal`. */
interface NonceStoreHost {
  claimWireNonceLocal(tenantId: string, scopeId: string, nonce: string, until: number): Promise<boolean>;
}

/**
 * The gate's `nonceCache` seam over a registry: the scope's nonce store for one call, or
 * `undefined` when this version has none. Asked by the gate only at the claim, after the envelope
 * verified, for the tenant and scope it names. A builder that throws is the store's failure, which
 * the gate answers as one.
 */
export function nonceStoreOf(registered: RegisteredHost) {
  return (env: unknown, scopeId: string, tenantId: string | null): WireNonceCache | undefined => {
    const hostFor = registered();
    if (!hostFor) return undefined;
    const store = hostFor(env as never) as Partial<NonceStoreHost> | null | undefined;
    // A call that keeps nonces names its tenant with its scope (RFC §3.1: both or neither).
    if (typeof store?.claimWireNonceLocal !== 'function' || tenantId === null) return undefined;
    const claim = store.claimWireNonceLocal.bind(store);
    return { claim: (nonce, until) => claim(tenantId, scopeId, nonce, until) };
  };
}
