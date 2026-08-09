import type { DeployAssets, PermissionRegistry, PlatformActorId, TenantId, VersionOrigin } from '@substrat-run/contracts';
import { LIST_PAGE_MAX, deployManifest, storedDeployManifest } from '@substrat-run/contracts';
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
  /**
   * This version's migrations differ from its PREDECESSOR's (#286) — updating to it
   * crosses a migration boundary, so the deployments UI badges it: a code-only
   * version is freely deployable and rollbackable; a schema-changing one triggers
   * the pre-migration bookmark and offers the time-boxed backout. False for the
   * first version (there is no update that reaches it).
   */
  schemaChange: boolean;
  /** Where this push came from (git CI vs a terminal) — null for a pre-tracking push. */
  origin: VersionOrigin | null;
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
  channels: Array<{ channel: string; versionId: string; servingVersionId?: string | null }>;
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
  migrationDigest?: string;
  origin?: VersionOrigin | null;
  createdAt?: string;
}

function shape(
  v: RawVertical,
  versions: RawVersion[],
  channels: Array<{ channel: string; versionId: string; servingVersionId?: string | null }>,
): Deployment {
  const i = v.slug.indexOf('/');
  return {
    slug: v.slug,
    displaySlug: i >= 0 ? v.slug.slice(i + 1) : v.slug,
    name: v.name,
    source: v.source,
    listed: !!v.listed,
    versions: (() => {
      // Chronological (ULID ids) to find each version's predecessor, then newest-first
      // for display. `schemaChange` is a digest comparison against the predecessor —
      // the same signal promote's acknowledgement gate reads (#286).
      const chrono = [...versions].sort((a, b) => (a.id < b.id ? -1 : 1));
      const changed = new Map<string, boolean>(
        chrono.map((r, i) => {
          const prev = i > 0 ? chrono[i - 1] : undefined;
          return [
            r.id,
            prev !== undefined &&
              r.migrationDigest !== undefined &&
              r.migrationDigest !== prev.migrationDigest,
          ];
        }),
      );
      return chrono.reverse().map((r) => ({
        id: r.id,
        version: r.version,
        admission: r.admission,
        admissionNote: r.admissionNote ?? null,
        deploymentRef: r.deploymentRef ?? null,
        schemaChange: changed.get(r.id) ?? false,
        origin: r.origin ?? null,
        createdAt: r.createdAt ?? '',
      }));
    })(),
    // Normalize: the host returns full VerticalChannel rows (verticalSlug, updatedAt);
    // the view needs which version each channel points at, plus what prod is ACTUALLY
    // serving (#321) so a failed in-place serve reads honestly instead of "deployed".
    channels: channels.map((c) => ({
      channel: c.channel,
      versionId: c.versionId,
      servingVersionId: c.servingVersionId ?? null,
    })),
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

/** A `Deployment` whose `versions` is ONE keyset page (newest first); `nextCursor` walks older. */
export interface DeploymentPage extends Deployment {
  nextCursor: string | null;
}

/**
 * Shape ONE page of raw versions, newest-first, keyset on the ULID id (#458-shape).
 * `raws` arrives `order:'desc'` with ONE extra row over `limit` when the fetch could
 * overfetch, so the last DISPLAYED row still has its predecessor in hand for the
 * `schemaChange` digest comparison (in desc order a row's predecessor is the next
 * row). `tailCursor` covers the max-size page that could not overfetch: the source's
 * own nextCursor (its last row's schemaChange then reads false — predecessor unknown).
 */
export function shapeVersionsPage(
  raws: RawVersion[],
  limit: number,
  tailCursor: string | null,
): { versions: DeploymentVersion[]; nextCursor: string | null } {
  const display = raws.slice(0, limit);
  const versions = display.map((r, i) => {
    const prev = raws[i + 1];
    return {
      id: r.id,
      version: r.version,
      admission: r.admission,
      admissionNote: r.admissionNote ?? null,
      deploymentRef: r.deploymentRef ?? null,
      schemaChange:
        prev !== undefined && r.migrationDigest !== undefined && r.migrationDigest !== prev.migrationDigest,
      origin: r.origin ?? null,
      createdAt: r.createdAt ?? '',
    };
  });
  const last = display[display.length - 1];
  const nextCursor = raws.length > limit ? last!.id : display.length === limit ? tailCursor : null;
  return { versions, nextCursor };
}

/** The overfetch size for a versions page: one extra row for `schemaChange`, capped at the CP max. */
const versionsFetchLimit = (limit: number): number => Math.min(limit + 1, LIST_PAGE_MAX);

/**
 * ONE vertical's deployment record with a PAGED versions list (the per-app
 * Deployments tab, `GET /api/apps/:scopeId/deployments`): newest first, `limit`
 * rows, `cursor` walking older. Channels stay complete — there are ~3.
 */
export async function verticalDeploymentPageFromCp(
  cp: TenantNarrowedControlPlane,
  slug: string,
  page: { limit: number; cursor?: string },
): Promise<DeploymentPage> {
  const fetchLimit = versionsFetchLimit(page.limit);
  const [res, channels] = await Promise.all([
    cp.listVersionsPage(slug, { limit: fetchLimit, cursor: page.cursor, order: 'desc' }),
    cp.listChannels(slug),
  ]);
  const { versions, nextCursor } = shapeVersionsPage(res.entries, page.limit, res.nextCursor);
  return { ...shape({ slug, name: slug, source: 'builtin', ownerTenant: null }, [], channels), versions, nextCursor };
}

export async function verticalDeploymentPageFromHost(
  host: ScopeHost,
  actor: PlatformActorId,
  slug: string,
  page: { limit: number; cursor?: string },
): Promise<DeploymentPage> {
  const fetchLimit = versionsFetchLimit(page.limit);
  const [raws, channels] = await Promise.all([
    host.admin.listVersions(actor, slug, { limit: fetchLimit, cursor: page.cursor, order: 'desc' }),
    host.admin.listChannels(actor, slug),
  ]);
  const { versions, nextCursor } = shapeVersionsPage(
    raws,
    page.limit,
    // A full fetch MAY have more (pageOf semantics); a short one is exhausted.
    raws.length >= fetchLimit ? (raws[raws.length - 1]?.id ?? null) : null,
  );
  return { ...shape({ slug, name: slug, source: 'builtin', ownerTenant: null }, [], channels), versions, nextCursor };
}

/**
 * One version's declared permission registry (D-39, #336) from the local host (embedded /
 * single-process) — parsed out of the retained manifest with the platform actor. `null` for
 * a version that retained no manifest (pushed pre-#286) or declared no surface. The connected
 * path uses `cp.versionRegistry`, which does the same read behind the tenant-narrowed plane.
 */
export async function versionRegistryFromHost(
  host: ScopeHost,
  actor: PlatformActorId,
  slug: string,
  versionId: string,
): Promise<PermissionRegistry | null> {
  const json = await host.admin.versionManifest(actor, slug, versionId);
  if (!json) return null;
  return deployManifest.parse(JSON.parse(json)).registry ?? null;
}

/**
 * The static files (#340) one version ships, from the local host — the same read as
 * `versionRegistry` above, out of the same retained manifest, parsed with the LENIENT stored
 * schema so a version pushed before the permission registry was required stays readable.
 * `null` for a version that retained no manifest or shipped no static files.
 */
export async function versionAssetsFromHost(
  host: ScopeHost,
  actor: PlatformActorId,
  slug: string,
  versionId: string,
): Promise<DeployAssets | null> {
  const json = await host.admin.versionManifest(actor, slug, versionId);
  if (!json) return null;
  return storedDeployManifest.parse(JSON.parse(json)).assets ?? null;
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
