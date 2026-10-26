/**
 * The Zod instance these schemas were built with.
 *
 * Import `z` FROM HERE, not from 'zod', whenever you compose a contracts schema
 * into your own — `z.object({ facility: entityRef, unitPrice: money })` is the
 * pattern the engines themselves use, and it is what "parse, don't trust" asks
 * of every operation input.
 *
 * Zod schemas do not compose across copies or majors: the mix fails at RUNTIME
 * with `Invalid element at key "…": expected a Zod schema`, an error that points
 * nowhere near the cause. We are on Zod 4, which is what `pnpm add zod` gives
 * you today — so the trap is currently dormant, not gone. It re-arms the day Zod
 * 5 ships, and it bit us once already (the packages were Zod 3 while the docs
 * told users to install the then-current Zod 4).
 *
 * Importing `z` from here means the consumer never installs zod at all, so the
 * versions cannot diverge no matter what the registry's `latest` becomes.
 */
export { z } from 'zod';

export * from './ids.js';
export * from './registry.js';
export * from './request-trace.js';
export * from './trace-sink.js';
export * from './script-names.js';
// The base64url helpers stay on the ./scope-store-envelope subpath, not the root.
export {
  SCOPE_STORE_ENVELOPE_VERSION,
  SCOPE_STORE_ENVELOPE_WINDOW_SECONDS,
  SCOPE_STORE_ENVELOPE_HEADER,
  SCOPE_STORE_SIGNATURE_HEADER,
  ScopeStoreKeyError,
  canonicalScopeStoreEnvelope,
  issueScopeStoreEnvelope,
  parseScopeStoreEnvelope,
  parseScopeStorePublicKeys,
  scopeStorePublicKeysFrom,
  scopeStoreBodyDigest,
  scopeStoreEnvelopeAdmits,
  scopeStoreEnvelopeFresh,
  scopeStoreKeyId,
  verifyScopeStoreCall,
  verifyScopeStoreEnvelope,
  type IssuedScopeStoreEnvelope,
  type ScopeStoreAudience,
  type ScopeStoreCallVerdict,
  type ScopeStoreEnvelope,
  type ScopeStorePublicKeys,
  type ScopeStoreRefusal,
} from './scope-store-envelope.js';
export * from './scope-store-transport.js';
export * from './routing.js';
export * from './invocation-record.js';
export * from './wire-headers.js';
export * from './hostnames.js';
export * from './tenancy.js';
export * from './introspection.js';
export * from './sql-tokens.js';
export * from './sql-in-list.js';
export * from './lifecycle-flow.js';
export * from './operation-series.js';
export * from './pagination.js';
export * from './concurrency.js';
export * from './idempotency.js';
export * from './connections.js';
export * from './connection-landing.js';
export * from './connection-health.js';
export * from './control-plane.js';
export * from './lake.js';
export * from './findings.js';
export * from './permission.js';
export * from './impersonation.js';
export * from './events.js';
export * from './vertical-events.js';
export * from './capability.js';
export * from './peer.js';
export * from './peer-transport.js';
export * from './relay-caller.js';
export * from './errors.js';
export * from './rate-limit.js';
export * from './platform-request.js';
export * from './denial.js';
export * from './refusal.js';
export * from './manifest.js';
export * from './openapi.js';
export * from './deploy.js';
export * from './reserved-keys.js';
export * from './entitlement-namespace.js';
export * from './migration-diff.js';
export * from './review-text.js';
export * from './registry-diff.js';
export * from './ci.js';
export * from './money.js';
export * from './attachments.js';
export * from './file-source.js';
export * from './mail-in.js';
export * from './kernel-events.js';
export * from './email-intent.js';
export * from './entity-state.js';
export * from './entity-stamps.js';
export * from './subject-erasure.js';
export * from './model.js';
export * from './operations.js';
export * from './lifecycle.js';
export * from './client-context.js';
export * from './model-usage.js';
export * from './seam.js';
export * from './signals.js';
export * from './mcp.js';
export * from './auth-delivery.js';
export * from './places.js';
export * from './delegations.js';
export * from './social-relay.js';
export * from './preview-client.js';
