import { z } from 'zod';

// Branded ID types: invalid states unrepresentable at the SDK boundary (§5.6/§5.8).
// ULIDs everywhere — sortable, opaque, no PII. IDs are logged outside jurisdictions
// by Cloudflare (billing/debug), so they must never encode meaning.

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const tenantId = z.string().regex(ULID).brand<'TenantId'>();
export type TenantId = z.infer<typeof tenantId>;

export const scopeId = z.string().regex(ULID).brand<'ScopeId'>();
export type ScopeId = z.infer<typeof scopeId>;

export const principalId = z.string().regex(ULID).brand<'PrincipalId'>();
export type PrincipalId = z.infer<typeof principalId>;

// An organization inside a tenant — the subject of membership tuples and the target
// of `grantToOrg` (K-22). Branded like every other id: `orgId` was a free-form string
// until orgs became a real record, so `acme` and `Acme` silently addressed different
// orgs and a typo in a grant reached a phantom nothing would ever resolve to.
export const orgId = z.string().regex(ULID).brand<'OrgId'>();
export type OrgId = z.infer<typeof orgId>;

// A platform-staff actor — the subject of every control-plane mutation (D-30, K-20).
// Branded DISTINCTLY from PrincipalId on purpose: a platform actor is not a principal
// in any tenant, and the compiler must refuse to confuse the two.
export const platformActorId = z.string().regex(ULID).brand<'PlatformActorId'>();
export type PlatformActorId = z.infer<typeof platformActorId>;

export const eventId = z.string().regex(ULID).brand<'EventId'>();
export type EventId = z.infer<typeof eventId>;

// A platform-intent request (platform-intents.md) — the id of a durable `_substrat_platform_requests`
// row a vertical enqueues via `ctx.requestPlatform` and the platform later drains. Branded like every
// other id so a request id can't be confused with an event or scope id.
export const platformRequestId = z.string().regex(ULID).brand<'PlatformRequestId'>();
export type PlatformRequestId = z.infer<typeof platformRequestId>;

export const dataSubjectId = z.string().regex(ULID).brand<'DataSubjectId'>();
export type DataSubjectId = z.infer<typeof dataSubjectId>;

// npm-package-shaped, e.g. '@substrat-run/engine-workorder'
export const moduleId = z
  .string()
  .regex(/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/)
  .brand<'ModuleId'>();
export type ModuleId = z.infer<typeof moduleId>;

// ISO 8601 with timezone (Z or offset). Stamped kernel-side, never caller-side.
export const instant = z.string().datetime({ offset: true }).brand<'Instant'>();
export type Instant = z.infer<typeof instant>;

// Module-namespaced permission key, e.g. 'workorder:create'
export const permissionKey = z
  .string()
  .regex(/^[a-z0-9-]+:[a-z0-9-]+$/)
  .brand<'PermissionKey'>();
export type PermissionKey = z.infer<typeof permissionKey>;

export const slug = z.string().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);

/**
 * A VERTICAL's registry id (builder-plane.md §2). A bare `slug`, optionally prefixed by
 * an owning tenant's slug: `<tenantSlug>/<name>`. The prefix makes a customer-chosen name
 * globally unique BY CONSTRUCTION — no claim race on the bare word — while a platform
 * vertical (owner_tenant = null) stays bare (`callout`). Exactly ONE `/` is allowed: both
 * halves are plain slugs. A builder never types the prefix; the control plane forms it
 * from the authenticated tenant (§5). It flows into `deploymentRefFor`, which flattens the
 * `/` to stay a valid CF script name; hostnames are per-instance and never carry it.
 */
export const verticalSlug = z
  .string()
  .regex(/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
