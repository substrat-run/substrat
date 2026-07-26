import type { PlatformActorId, TenantId } from '@substrat-run/contracts';
import type { ScopeHost } from '@substrat-run/kernel';
import type { TenantNarrowedControlPlane } from './authority.js';

/**
 * The builder-facing "Deployments" view (builder-plane.md §7, Phase 4) — the mirror of
 * the staff console's Verticals, narrowed to ONE tenant's own verticals. A customer sees
 * the verticals they pushed (`substrat push`), each version's admission state, and which
 * channel points where; they self-serve `dev`/`staging` promotion, while `prod` stays a
 * staff decision (model B).
 *
 * Ownership is `vertical.ownerTenant === tenant` (the `owner_tenant` column). Two sources
 * satisfy the same shape: the shared control plane (connected mode, prod) and the local
 * host (embedded / single-process). Both are filtered to the caller's tenant HERE — the
 * dashboard authenticated the customer and pinned their tenant, so a slug from another
 * tenant is never assembled and never promotable (checked again in `assertOwned`).
 */

export interface DeploymentVersion {
  id: string;
  version: string;
  admission: string;
  admissionNote: string | null;
  deploymentRef: string | null;
  createdAt: string;
}

export interface Deployment {
  /** The full registry id, e.g. `acme-co/helpdesk` — what API calls use. */
  slug: string;
  /** The bare name for display, prefix stripped (`helpdesk`). */
  displaySlug: string;
  name: string;
  source: string;
  /** Published to the public marketplace (marketplace-publish.md §2) vs private to this team. */
  listed: boolean;
  /** Newest-first (the id is a ULID — lexicographic order is chronological). */
  versions: DeploymentVersion[];
  channels: Array<{ channel: string; versionId: string }>;
}

interface RawVertical {
  slug: string;
  name: string;
  source: string;
  ownerTenant: TenantId | null;
  listed?: boolean;
}
interface RawVersion {
  id: string;
  version: string;
  admission: string;
  admissionNote?: string | null;
  deploymentRef?: string | null;
  createdAt?: string;
}

function shape(
  v: RawVertical,
  versions: RawVersion[],
  channels: Array<{ channel: string; versionId: string }>,
): Deployment {
  const i = v.slug.indexOf('/');
  return {
    slug: v.slug,
    displaySlug: i >= 0 ? v.slug.slice(i + 1) : v.slug,
    name: v.name,
    source: v.source,
    listed: !!v.listed,
    versions: [...versions]
      .sort((a, b) => (a.id < b.id ? 1 : -1))
      .map((r) => ({
        id: r.id,
        version: r.version,
        admission: r.admission,
        admissionNote: r.admissionNote ?? null,
        deploymentRef: r.deploymentRef ?? null,
        createdAt: r.createdAt ?? '',
      })),
    // Normalize: the host returns full VerticalChannel rows (verticalSlug, updatedAt);
    // the view needs only which version each channel points at.
    channels: channels.map((c) => ({ channel: c.channel, versionId: c.versionId })),
  };
}

/** From the local host (embedded / single-process). listVerticals returns ALL; filter here. */
export async function listDeploymentsFromHost(
  host: ScopeHost,
  actor: PlatformActorId,
  tenantId: TenantId,
): Promise<Deployment[]> {
  const owned = (await host.admin.listVerticals(actor)).filter((v) => v.ownerTenant === tenantId);
  return Promise.all(
    owned.map(async (v) =>
      shape(
        v,
        await host.admin.listVersions(actor, v.slug),
        await host.admin.listChannels(actor, v.slug),
      ),
    ),
  );
}

/** From the shared control plane (connected mode). `cp.listVerticals()` is tenant-filtered. */
export async function listDeploymentsFromCp(cp: TenantNarrowedControlPlane): Promise<Deployment[]> {
  const owned = await cp.listVerticals();
  return Promise.all(
    owned.map(async (v) =>
      shape(v, await cp.listVersions(v.slug), await cp.listChannels(v.slug)),
    ),
  );
}

/**
 * ONE vertical's deployment record (versions + channels) by slug — for the per-app
 * Deployments tab. Unlike the tenant-level lists above, this is keyed by the app's own
 * vertical (which may be a platform vertical the tenant doesn't "own"), so the app can
 * show which version it runs (the `prod` channel) and what else exists in the registry.
 */
export async function verticalDeploymentFromCp(cp: TenantNarrowedControlPlane, slug: string): Promise<Deployment> {
  return shape({ slug, name: slug, source: 'builtin', ownerTenant: null }, await cp.listVersions(slug), await cp.listChannels(slug));
}
export async function verticalDeploymentFromHost(host: ScopeHost, actor: PlatformActorId, slug: string): Promise<Deployment> {
  return shape({ slug, name: slug, source: 'builtin', ownerTenant: null }, await host.admin.listVersions(actor, slug), await host.admin.listChannels(actor, slug));
}

/**
 * The security check every promotion needs: the slug being promoted MUST be one the
 * caller's tenant owns. The dashboard acts on the shared plane with a staff-level service
 * token, so without this a customer could name another tenant's vertical. Throws if not.
 */
export function assertOwned(deployments: Deployment[], slug: string): void {
  if (!deployments.some((d) => d.slug === slug)) {
    throw new Error(`vertical '${slug}' is not one of your deployments`);
  }
}
