/**
 * `substrat publish <slug>` / `substrat unpublish <slug>` — list/unlist a vertical on the
 * PUBLIC marketplace (marketplace-publish.md §5). The control-plane `/verticals/:slug/listing`
 * endpoint is STAFF-only, so a builder is refused (the review gate); a staff/platform caller
 * flips it. Once `listed`, `availableCatalog` offers the vertical to every tenant.
 */
import { planeFor, viaPlane } from './plane.js';

export interface ListingOptions {
  controlPlaneUrl: string;
  header: Record<string, string>;
  slug: string;
  listed: boolean;
}

export async function setListing(opts: ListingOptions): Promise<{ slug: string; listed: boolean }> {
  return viaPlane(
    () => planeFor(opts.controlPlaneUrl, opts.header).setListing(opts.slug, opts.listed),
    (e) => new Error(`${opts.listed ? 'publish' : 'unpublish'} failed (${e.status}): ${(e.body ?? '').slice(0, 300)}`),
  );
}

/**
 * `substrat publish <slug>` — a builder REQUESTS listing (marketplace-publish.md §5). Any owner
 * may ask; a staff operator then reviews and lists it. Owner-checked control-plane-side.
 */
export async function requestPublish(opts: { controlPlaneUrl: string; header: Record<string, string>; slug: string }): Promise<void> {
  await viaPlane(
    () => planeFor(opts.controlPlaneUrl, opts.header).requestPublish(opts.slug),
    (e) => new Error(`publish request failed (${e.status}): ${(e.body ?? '').slice(0, 300)}`),
  );
}
