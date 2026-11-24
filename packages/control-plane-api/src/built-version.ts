/**
 * The version of a vertical already built from one source revision, if there is one.
 *
 * The studio's Run builds the project's saved revision into a version before it binds that
 * version to a preview slot, and a build is minutes in a fresh container. When the revision is
 * one the platform has already built (the commit prod was released from, or the one the last Run
 * built), that build is redone for nothing. A source build stamps `manifest.build.revision` itself
 * (D-66, the builder's agent), after the project's code ran and from the commit it checked out,
 * so the stored manifest is the authority here. A version's `origin` is not: a snapshot push
 * supplies its own.
 *
 * Bounded on purpose. A manifest is the largest thing the directory holds, so the search reads
 * only the version prod points at, the one it serves, and the newest few. That covers the cases
 * Run meets (an unchanged project, and a Run straight after a release), and a revision built
 * long ago and since pushed past is built again, as it was before this existed.
 */
import { z, type PlatformActorId, type VerticalVersion } from '@substrat-run/contracts';
import type { HostAdmin } from '@substrat-run/kernel';

/** How many of the newest versions are searched, beside prod's. */
export const BUILT_VERSION_WINDOW = 10;

/** A git commit, as `manifest.build.revision` stores it. */
export const buildRevision = z.string().regex(/^[0-9a-f]{40}$/);

/** The one field the search reads; the rest of a stored manifest is not parsed. */
const stamped = z.object({ build: z.object({ revision: z.string() }).nullish() });

type Reader = Pick<HostAdmin, 'listChannels' | 'listVersions' | 'getVersion' | 'versionManifest'>;

/**
 * The newest admissible version of `slug` built from `revision`, among prod's and the newest
 * {@link BUILT_VERSION_WINDOW}; undefined when none is. A rejected version is passed over: it was
 * refused, and a preview of it would show code the vertical's owner turned away.
 */
export async function versionBuiltFrom(
  admin: Reader,
  actor: PlatformActorId,
  slug: string,
  revision: string,
  window: number = BUILT_VERSION_WINDOW,
): Promise<VerticalVersion | undefined> {
  const prod = (await admin.listChannels(actor, slug)).find((ch) => ch.channel === 'prod');
  const newest = await admin.listVersions(actor, slug, { limit: window, order: 'desc' });
  const pinned = [prod?.servingVersionId, prod?.versionId].filter((id): id is string => !!id);
  // Prod's versions join the newest-first window when they have fallen out of it.
  const candidates = [...newest];
  for (const id of pinned) {
    if (candidates.some((v) => v.id === id)) continue;
    const found = await admin.getVersion(actor, id, slug);
    if (found) candidates.push(found);
  }
  for (const version of candidates) {
    if (version.admission === 'rejected') continue;
    const json = await admin.versionManifest(actor, slug, version.id);
    // A cheap refusal first: a manifest that does not hold the commit's text was not built from it.
    if (!json || !json.includes(revision)) continue;
    const parsed = stamped.safeParse(JSON.parse(json));
    if (parsed.success && parsed.data.build?.revision === revision) return version;
  }
  return undefined;
}
