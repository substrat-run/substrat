import { shopProvider } from './seed.js';
import {
  platformActorId,
  principalId,
  type PrincipalId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import type { AuthSubject, DevLogin } from '@substrat-run/dev-issuer';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { SHOP_PERM } from './module.js';
import type { ShopWorld } from './seed.js';
import { ROLE_HINTS } from './personas.js';

/**
 * The auth seam. `resolvePrincipal` tries each mounted adapter in order; the
 * first to recognise the request wins. The kernel never sees any of this — it
 * only ever gets a `PrincipalId`.
 *
 * Two adapters, and only one of them is authentication: an OIDC session resolved at the
 * issuer, then the anonymous browse-only fallback. The shop runs no credential store —
 * accounts, passwords and sign-up live at `OIDC_ISSUER` (locally
 * `@substrat-run/dev-issuer`), which is why there is no `auth.ts` here any more. The
 * storefront's anonymous visitor is NOT a credential and stays.
 */
export interface AuthResult {
  principal: PrincipalId;
  tenantId: TenantId;
  scopeId: ScopeId;
  via: string; // 'oidc' | 'public'
  display: string;
  role: string; // UI hint only ('shop-admin' | 'warehouse' | 'customer' | 'public'); the kernel still enforces
}
export interface AuthAdapter {
  id: string;
  resolve(headers: Headers): Promise<AuthResult | null>;
}

/** Anonymous fallback: not-logged-in visitors resolve to a browse-only principal. */
export function publicAuth(world: ShopWorld): AuthAdapter {
  return {
    id: 'public',
    async resolve() {
      return {
        principal: world.public,
        tenantId: world.t1,
        scopeId: world.s1,
        via: 'public',
        display: 'Gäst',
        role: 'public',
      };
    },
  };
}

/**
 * OIDC: a session at the issuer → the subject it asserts → the principal that subject is
 * bound to in this storefront's pool.
 *
 * `login.subject` rather than `login.caller`, deliberately. `caller` answers "which tenant
 * is this login in?" by asking the directory, which is the right question for a CENTRAL
 * pool. This shop's pool is tenant-bound (K-23 — a white-label storefront), so the tenant
 * is not a question: it is `world.t1`, the one storefront this server serves. Asking the
 * directory instead would be asking a question whose answer is already known, and would
 * quietly pick the first of several if a second instance ever shared the process.
 */
export function oidcAdapter(login: DevLogin, host: SqliteScopeHost, world: ShopWorld): AuthAdapter {
  return {
    id: 'oidc',
    async resolve(headers) {
      const subject = await login.subject(headers);
      if (!subject) return null;
      const mapped =
        (await host.admin.resolveIdentity(world.t1, shopProvider('kallkalla'), subject.sub)) ??
        (await provisionShopper(host, world, subject));
      return {
        principal: mapped.principal,
        tenantId: world.t1,
        scopeId: mapped.scopeId ?? world.s1,
        via: 'oidc',
        display: subject.name ?? subject.email ?? 'kund',
        role: ROLE_HINTS[subject.sub] ?? 'customer',
      };
    },
  };
}

/**
 * First arrival of a subject we have not seen: the plan's §4.3 identity sync, TOFU. Mint a
 * principal, give it the `shopper` role, create its customer, grant entity-narrowed
 * `order:read` on that customer, and bind the identity in the directory. A real signup
 * then gets real portal isolation.
 *
 * The link is written under the SAME provider the lookup above reads
 * (`shopProvider('kallkalla')`). It used to be written under a bare `better-auth` while the
 * lookup asked for `better-auth:kallkalla`, so the lookup could never hit: every request
 * from a self-service shopper re-ran this function and minted another principal and another
 * customer row. One constant on both sides is what stops that.
 */
async function provisionShopper(
  host: SqliteScopeHost,
  world: ShopWorld,
  subject: AuthSubject,
): Promise<{ principal: PrincipalId; scopeId: ScopeId | null }> {
  const staff = platformActorId.parse(ulid());
  const principal = principalId.parse(ulid());

  // The customer record is created by the admin (customer:manage) — number keyed
  // off the subject so it is stable and collision-free across restarts.
  const admin = await host.getScope(world.astrid, world.t1, world.s1);
  const customer = await admin.invoke<{ id: string }>('shop/create-customer', {
    number: `W-${subject.sub.slice(0, 10)}`,
    name: subject.name || subject.email || 'Webbkund',
    orgRef: `${shopProvider('kallkalla')}:${subject.sub}`,
  });

  await host.admin.assignRole(staff, {
    principalId: principal,
    roleKey: 'shopper',
    node: { tenantId: world.t1, scopeId: world.s1 },
  });
  await host.admin.grant(staff, {
    principalId: principal,
    permission: SHOP_PERM.orderRead,
    node: { tenantId: world.t1, scopeId: world.s1 },
    entity: { entityType: 'customer', entityId: customer.id },
    grantedBy: world.astrid,
  });
  await host.admin.linkIdentity(staff, {
    provider: shopProvider('kallkalla'),
    externalId: subject.sub,
    principal,
    tenantId: world.t1,
    scopeId: world.s1,
  });

  return { principal, scopeId: world.s1 };
}

/** Resolve a request to a principal across all mounted adapters; null if none match. */
export async function resolvePrincipal(
  adapters: AuthAdapter[],
  headers: Headers,
): Promise<AuthResult | null> {
  for (const a of adapters) {
    const r = await a.resolve(headers);
    if (r) return r;
  }
  return null;
}
