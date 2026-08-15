import { TENANT_HEADER } from '@substrat-run/control-plane-api';
import type { BuilderAuth, BuilderIdentity } from '@substrat-run/control-plane-api';
import { platformActorId, type PlatformActorId, type TenantId } from '@substrat-run/contracts';
import type { ScopeHost } from '@substrat-run/kernel';
import { sessionFromHeaders, verifySession, type OidcEnv, type SessionUser } from '@substrat-run/oidc-rp';

/**
 * The BUILDER identity seam on the edge (builder-plane.md §4). The mirror of
 * `staff-auth.ts`, but for a *tenant user*: the same signed session (bearer from the CLI,
 * `sb_session` cookie from a browser) resolves to the tenants that user belongs to, and —
 * narrowed to the selected one — to a `(actor, tenantId, tenantSlug)` builder principal.
 *
 * There is no vetting roster (unlike staff): self-serve is the point (Vercel-style). The
 * `<tenantSlug>/<name>` prefix (formed control-plane-side, §5) makes slugs non-scarce, so
 * anyone who has signed up can claim and push under their own namespace. Staff keep the
 * prod gate (model B); a builder never reaches it.
 *
 * `null` means "not a builder session here" (no session, no workspace yet, or an ambiguous
 * multi-tenant caller with no selection) — the API then falls through to fail-closed 401.
 */

// The same central identity pool the dashboard registers (worker.ts): links created at
// dashboard sign-up live in the shared ControlPlaneDO, and this reads the same ones.
const PROVIDER = 'authhero';

// A platform actor used ONLY to read the identity directory while resolving a builder —
// the directory reads are HostAdmin calls and want a subject for their access log. It is
// not the builder's audited actor (that is `builderActorFor`, below).
const BUILDER_RESOLVER = platformActorId.parse('01JZ000000000000000000BDR1');

// The tenant-selection header (`--tenant`) is the shared TENANT_HEADER: a tenant id
// (ULID) or the tenant's slug; the sole membership is used when it is absent.

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * A stable `PlatformActorId` for a builder user — the audited subject on the control-plane
 * admin log (§4.4: a builder is as nameable as staff). Deterministic from the OIDC subject,
 * so the same human always maps to the same actor id, and Web-Crypto only (workerd-safe).
 */
export async function builderActorFor(userId: string): Promise<PlatformActorId> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`builder:${userId}`)),
  );
  let s = '';
  for (let i = 0; i < 26; i++) s += CROCKFORD[digest[i]! % 32];
  return platformActorId.parse(s);
}

/** Read the session (CLI bearer first, then the browser cookie), or null. */
async function sessionUser(env: OidcEnv, request: Request): Promise<SessionUser | null> {
  const header = request.headers.get('authorization') ?? '';
  const bearer = /^bearer /i.test(header) ? header.slice(7).trim() : undefined;
  return bearer ? await verifySession(env, bearer) : await sessionFromHeaders(env, request.headers);
}

export interface ResolvedTenant {
  id: TenantId;
  slug: string;
  name: string;
}

/**
 * The entitlement key that turns the builder STUDIO on for a tenant
 * (builder-plane.md §7's "entitlement flag, presumably" — now actual). Granted
 * from the console like any SKU (TenantDetail → Grant entitlement); expiry is
 * honoured at read below, so a lapsed trial reads as not entitled. Deliberately
 * NOT consulted by the CLI/whoami path: self-serve push stays roster-free
 * (Vercel-style, the header comment above) — this key gates the hosted studio
 * surface, not the ability to push.
 */
export const BUILDER_ENTITLEMENT = 'builder';

/** A membership decorated with whether that tenant holds the studio entitlement. */
export interface StudioTenant extends ResolvedTenant {
  entitled: boolean;
}

/**
 * The studio's membership + entitlement read (`/internal/builder/identity-tenants`):
 * the same directory walk as `builderTenantsFor`, each tenant flagged with whether
 * it currently holds [[BUILDER_ENTITLEMENT]]. Expiry applies here — the kernel
 * only enforces it at its own per-invoke gate, and `listEntitlements` deliberately
 * keeps lapsed rows visible for renewal, so this read must not mistake a lapsed
 * trial for access.
 */
export async function studioTenantsFor(
  host: ScopeHost,
  user: Pick<SessionUser, 'id'>,
): Promise<StudioTenant[]> {
  const tenants = await builderTenantsFor(host, user);
  const now = new Date().toISOString();
  return await Promise.all(
    tenants.map(async (t) => {
      const grants = await host.admin.listEntitlements(BUILDER_RESOLVER, t.id);
      const entitled = grants.some(
        (g) =>
          g.entitlementKey === BUILDER_ENTITLEMENT &&
          (g.expiresAt === null || g.expiresAt > now),
      );
      return { ...t, entitled };
    }),
  );
}

/**
 * The tenants a session's user belongs to (for `GET /api/auth/whoami` and the reader).
 * Reads the shared identity directory; empty when the user has not signed up yet.
 */
export async function builderTenantsFor(
  host: ScopeHost,
  user: Pick<SessionUser, 'id'>,
): Promise<ResolvedTenant[]> {
  const admin = host.admin;
  // The pool must exist to ask which tenants a login is in (central topology). Idempotent.
  await admin.registerIdentityPool(BUILDER_RESOLVER, { provider: PROVIDER, topology: 'central', tenantId: null });
  const ids = await admin.listIdentityTenants(BUILDER_RESOLVER, PROVIDER, user.id);
  const out: ResolvedTenant[] = [];
  for (const id of ids) {
    const t = await admin.getTenant(BUILDER_RESOLVER, id);
    if (t) out.push({ id, slug: t.slug, name: t.name });
  }
  return out;
}

/**
 * `GET /api/auth/whoami` — the current session's user + the tenants it can build for.
 * The CLI calls it on `login` to store a default tenant (and to prompt when there are
 * several). Null user ⇒ not signed in.
 */
export async function resolveWhoami(
  host: ScopeHost,
  env: OidcEnv,
  request: Request,
): Promise<{ user: { id: string; email?: string } | null; tenants: ResolvedTenant[] }> {
  const user = await sessionUser(env, request);
  if (!user?.id) return { user: null, tenants: [] };
  return { user: { id: user.id, email: user.email }, tenants: await builderTenantsFor(host, user) };
}

export function oidcBuilderReader(host: ScopeHost, env: OidcEnv): BuilderAuth {
  return async (request): Promise<BuilderIdentity | null> => {
    const user = await sessionUser(env, request);
    if (!user?.id) return null;

    const tenants = await builderTenantsFor(host, user);
    if (tenants.length === 0) return null; // no workspace yet — sign up in the dashboard first

    // Pick the tenant: an explicit `--tenant` (id or slug), else the sole membership. A
    // multi-tenant user with no selection is ambiguous → decline (the CLI must pass one).
    const selection = request.headers.get(TENANT_HEADER)?.trim();
    const chosen = selection
      ? tenants.find((t) => t.id === selection || t.slug === selection)
      : tenants.length === 1
        ? tenants[0]
        : undefined;
    if (!chosen) return null;

    return { actor: await builderActorFor(user.id), tenantId: chosen.id, tenantSlug: chosen.slug };
  };
}
