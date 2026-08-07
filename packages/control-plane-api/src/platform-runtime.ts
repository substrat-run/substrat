/**
 * Where this platform's compute and per-tenant stores physically live (#537-adjacent ops
 * ergonomics): the coordinates a staff surface turns into a link into the provider's own
 * console — this scope's serving script, this tenant's database, this tenant's bucket.
 *
 * Substrate-agnostic on purpose. The control plane already knows a scope's `servingRef`,
 * a store's `ref`, and a version's `deploymentRef`; what it has never told anyone is
 * WHERE those refs resolve. That is one descriptor, not a Cloudflare dependency: this
 * package still holds no provider SDK and no credential (D-34), and the pure adapter
 * simply has no runtime to describe (`provider` absent ⇒ the console shows plain ids).
 */
export interface PlatformRuntime {
  /** The substrate these refs resolve in. Only Cloudflare exists today; the tag is what
   *  lets a consumer refuse to build links for a substrate it does not know. */
  provider: 'cloudflare';
  /** The account the platform's scripts, databases and buckets belong to. */
  accountId: string;
  /** The dispatch namespace pushed verticals run in (WfP) — where a `servingRef` or a
   *  version's `deploymentRef` is a script name. */
  dispatchNamespace: string;
}
