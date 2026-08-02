import type { EnvVarSpec, PermissionKey, PlatformActorId, Vertical } from '@substrat-run/contracts';
import type { ScopeHost } from '@substrat-run/kernel';
import { PROTOCOL_PERM as PROTO } from '@substrat-run/engine-protocol';
import { PERM as WO } from '@substrat-run/engine-workorder';
import { INVOICING_PERM as INV } from '@substrat-run/engine-invoicing';
import { SC_PERM } from '@substrat-run/demo-callout/manifest';
import { HR_PERM } from '@substrat-run/demo-meridian/manifest';
import { MF_PERM } from '@substrat-run/demo-manyfold/manifest';

/**
 * The catalog — the verticals a customer can instantiate, and the provisioning
 * specifics the version registry does not carry (the SKU the app loads under, what the
 * owner is granted in a fresh app). Kept free of Cloudflare imports so the availability
 * rules below are unit-testable in node (the worker itself pulls in `cloudflare:workers`).
 */
export interface CatalogEntry {
  name: string;
  entitlements: string[];
  ownerGrants: PermissionKey[];
  /**
   * Is this vertical provisionable on the SHARED control plane (hosted / production)?
   * The plane provisions via a static `VERTICAL_<slug>` binding or a promoted
   * dispatch-namespace version; a vertical with neither returns 501 "no deployment is
   * bound". Defaults to provisionable; set `false` for one that is bundled here (so
   * embedded/standalone can run it) but not yet deployed to the plane — the catalog then
   * hides it in connected mode instead of offering an install that always fails. Flip to
   * true (or drop the flag) once the vertical is deployed + promoted to prod.
   */
  connected?: boolean;
  /**
   * Declared environment for this vertical — placeholder + description per key, so the
   * dashboard can render a real settings form. Populated for STANDALONE apps whose own
   * worker script owns its secrets (e.g. an auth server); a hosted dispatch vertical takes
   * per-tenant config through the connection store instead of per-app worker secrets, so it
   * leaves this empty. Mirrors a vertical's own `moduleManifest.envSpec` / app manifest.
   */
  envSpec?: EnvVarSpec[];
  /** Capabilities this vertical provides (e.g. `oidc-issuer`) — manifest `provides` (#427). */
  provides?: string[];
  /** Capabilities this vertical can consume at install (e.g. `oidc-issuer`) — manifest `requires` (#427). */
  requires?: string[];
}

export const CATALOG: Record<string, CatalogEntry> = {
  protocol: {
    name: 'Documents',
    entitlements: ['protocol'],
    ownerGrants: [PROTO.create, PROTO.read] as PermissionKey[],
  },
  // Callout composes three engines, so its SKU is three entitlement flags, and its
  // owner receives the `office-admin` permission set (demos/callout provision.ts)
  // as a flat grant — the Dashboard grants perms per-principal rather than defining
  // roles in the app scope.
  callout: {
    name: 'Callout',
    entitlements: ['workorder', 'invoicing', 'protocol', 'callout'],
    ownerGrants: [
      SC_PERM.customerManage, SC_PERM.facilityManage,
      WO.create, WO.read, WO.assign, WO.report, WO.complete, WO.close,
      INV.read, INV.export,
      PROTO.create, PROTO.fill, PROTO.sign, PROTO.read, PROTO.void,
    ] as PermissionKey[],
  },
  // Meridian runs the HR domain on the kernel plus protocol (onboarding). Its SKU is
  // two flags (`meridian` + `protocol`); the installing owner receives the `hr-admin`
  // permission set (demos/meridian provision.ts `hrAdminPerms`) as a flat grant, so a
  // freshly-installed instance's owner can define leave types, create employees and
  // projects, approve leave/expenses, and drive onboarding contracts from day one.
  meridian: {
    name: 'Meridian',
    // Deployed to the shared control plane's dispatch namespace and promoted to prod, so the
    // hosted catalog now offers it. (Was `connected: false` while it wasn't yet deployable.)
    connected: true,
    // Mirrors the vertical's own manifest `requires` (#427): the install form offers the
    // tenant's `oidc-issuer` providers to bind; builtin auth stays the default.
    requires: ['oidc-issuer'],
    entitlements: ['meridian', 'protocol'],
    ownerGrants: [
      HR_PERM.employeeManage, HR_PERM.absenceConfigure, HR_PERM.absenceApprove, HR_PERM.absenceRead,
      HR_PERM.timeRead, HR_PERM.projectManage, HR_PERM.expenseApprove, HR_PERM.expenseRead, HR_PERM.payrollExport,
      // PROTO.recordSignature is deliberately excluded — it speaks for the signing
      // provider (a connection holds it), never a human role (provision.ts).
      PROTO.create, PROTO.fill, PROTO.bind, PROTO.requestSignature, PROTO.sign, PROTO.read, PROTO.void,
    ] as PermissionKey[],
  },
  // Manyfold is a multi-scope headless CMS: one install, many SITES (each a scope). Its SKU
  // is one flag (`manyfold`); the installing owner receives the full content permission set as
  // a flat grant, so a fresh instance's owner can model, author, review, and publish from day
  // one. (The per-SITE role model — Meridian's `assignScopeRole` replicated per site — is the
  // productization the flat grant stands in for; cms-content.md §8.4.) Bundled in the worker
  // but not yet deployed to the shared control plane, so it is hidden in connected mode until
  // it ships (flip to `connected: true` once deployed + promoted).
  manyfold: {
    name: 'Manyfold',
    // Deployed to the shared control plane's dispatch namespace and promoted to prod, so the
    // hosted catalog now offers it. (Was `connected: false` while it wasn't yet deployable.)
    connected: true,
    entitlements: ['manyfold'],
    ownerGrants: [MF_PERM.read, MF_PERM.author, MF_PERM.review, MF_PERM.publish, MF_PERM.admin] as PermissionKey[],
  },
};

/** Seed the registry from the catalog (idempotent) — what `GET /api/catalog` lists. The
 *  vertical's declared `envSpec` rides along, so the dashboard renders its config form from
 *  the registry (uniformly for builtin + pushed verticals), not from this hardcoded map. */
export async function ensureCatalog(host: ScopeHost, staff: PlatformActorId): Promise<void> {
  for (const [slug, e] of Object.entries(CATALOG)) {
    await host.admin.registerVertical(staff, {
      slug,
      name: e.name,
      source: 'builtin',
      // The provisioning specifics ride to the registry (marketplace-publish.md §3), so
      // install reads them from there — not this map. First-party verticals are PUBLISHED to
      // everyone (`listed`), unless bundled-but-not-yet-deployed (`connected: false`), which
      // stays private so it isn't offered an install that 501s in connected mode.
      entitlements: e.entitlements,
      ownerGrants: e.ownerGrants,
      listed: e.connected !== false,
      ...(e.envSpec ? { envSpec: e.envSpec } : {}),
      // Capabilities ride to the registry too (#427), so install-time binding reads
      // them off the row — a builtin and a pushed vertical resolve identically.
      ...(e.provides ? { provides: e.provides } : {}),
      ...(e.requires ? { requires: e.requires } : {}),
    });
  }
}

/**
 * One row of the install catalog — the New-app page groups on these flags: `listed` ⇒ the
 * public **Marketplace** group, `owned` ⇒ the caller's **Your verticals** group (private to
 * their team unless also `listed`). `source` lets the endpoint decide installability
 * (a builtin is always provisionable; a pushed vertical needs a prod-promoted version).
 */
export interface CatalogListing {
  slug: string;
  name: string;
  owned: boolean;
  listed: boolean;
  source: string;
  /**
   * The vertical's declared env-spec, carried to the install form (#426): the New-app
   * page renders these fields so first-run values — an issuer's bootstrap ADMIN_*, an
   * app's API keys — flow IN with provisioning instead of the instance arriving live
   * but unconfigured. Same spec the Env tab renders after install.
   */
  envSpec?: EnvVarSpec[];
  /**
   * Declared capabilities (#427, marketplace-publish.md §4). `provides` marks a vertical
   * whose instances can be BOUND by others (an `oidc-issuer` shows up in the Identity
   * picker; the vertical itself gets no Identity section — an issuer doesn't delegate to
   * another issuer). `requires` marks a vertical that can consume one at install.
   */
  provides?: string[];
  requires?: string[];
}

/**
 * The verticals to advertise for a caller — REGISTRY-DRIVEN (marketplace-publish.md §3), no
 * hardcoded gate: a vertical shows if it's PUBLISHED (`listed`) or OWNED by the caller's tenant
 * (private to your team). So a pushed → promoted → published vertical appears with no dashboard
 * change. `verticals` is the registry listing; the result is what the endpoint returns
 * (minus `installable`, which needs channel reads the worker does).
 */
export function availableCatalog(
  verticals: readonly Vertical[],
  opts: { tenantId: string | null },
): CatalogListing[] {
  const owned = (v: Vertical) => opts.tenantId !== null && v.ownerTenant === opts.tenantId;
  return verticals
    // Install-blocked verticals are offered to NOBODY, owner included — the catalog is
    // the offer side of the kill-switch; the control plane's instances route is the gate.
    .filter((v) => !v.installsBlocked)
    .filter((v) => v.listed || owned(v))
    .map((v) => ({
      slug: v.slug,
      name: v.name,
      owned: owned(v),
      listed: v.listed,
      source: v.source,
      ...(v.envSpec?.length ? { envSpec: v.envSpec } : {}),
      ...(v.provides?.length ? { provides: v.provides } : {}),
      ...(v.requires?.length ? { requires: v.requires } : {}),
    }));
}

/**
 * The slugs whose instances can serve as `oidc-issuer` providers (#427): every registered
 * vertical that DECLARES the capability, plus the literal `auth-server` — the pre-declaration
 * provider (registry rows pushed before `provides` existed carry no capability, and its
 * app rows must keep resolving as issuers).
 */
export function oidcIssuerProviderSlugs(
  verticals: ReadonlyArray<Pick<Vertical, 'slug' | 'provides'>>,
  remote?: ReadonlyArray<{ slug: string; provides?: string[] }>,
): Set<string> {
  const slugs = new Set(['auth-server']);
  for (const v of verticals) if (v.provides?.includes('oidc-issuer')) slugs.add(v.slug);
  for (const v of remote ?? []) if (v.provides?.includes('oidc-issuer')) slugs.add(v.slug);
  return slugs;
}
