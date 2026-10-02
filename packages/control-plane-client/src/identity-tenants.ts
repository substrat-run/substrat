import { slug, tenantId, z } from '@substrat-run/contracts';

/**
 * A tenant a login builds for, as the control plane's studio membership read states it
 * (`POST /internal/builder/identity-tenants`, builder-plane.md §4).
 *
 * The three directory fields are parsed with the SAME schemas the `tenant` record
 * publishes (`contracts/src/tenancy.ts`), not with generic strings: the id is a ULID, the
 * slug is the constrained slug, the name is non-empty. That costs nothing in lockout risk
 * — `createTenantInput` picks those same three, so a tenant that exists satisfied them at
 * creation — and it buys the half a loose parse would miss. A non-empty but malformed id
 * passes `z.string()` and then becomes a Durable Object key and a team route, which is the
 * downstream use this parse exists to protect.
 */
export const identityTenant = z.object({
  id: tenantId,
  slug,
  name: z.string().min(1),
  /** Whether the tenant holds the `builder` entitlement (the control plane applies expiry at read). */
  entitled: z.boolean(),
});

/** The `/internal/builder/identity-tenants` response body. */
export const identityTenantsResponse = z.object({ tenants: z.array(identityTenant) });

export type IdentityTenant = z.infer<typeof identityTenant>;
