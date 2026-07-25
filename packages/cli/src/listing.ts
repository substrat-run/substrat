/**
 * `substrat publish <slug>` / `substrat unpublish <slug>` — list/unlist a vertical on the
 * PUBLIC marketplace (marketplace-publish.md §5). The control-plane `/verticals/:slug/listing`
 * endpoint is STAFF-only, so a builder is refused (the review gate); a staff/platform caller
 * flips it. Once `listed`, `availableCatalog` offers the vertical to every tenant.
 */
export interface ListingOptions {
  controlPlaneUrl: string;
  header: Record<string, string>;
  slug: string;
  listed: boolean;
}

export async function setListing(opts: ListingOptions): Promise<{ slug: string; listed: boolean }> {
  const base = opts.controlPlaneUrl.replace(/\/$/, '');
  const url = `${base}/verticals/${encodeURIComponent(opts.slug)}/listing`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...opts.header, 'content-type': 'application/json' },
    body: JSON.stringify({ listed: opts.listed }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`${opts.listed ? 'publish' : 'unpublish'} failed (${res.status}): ${body.slice(0, 300)}`);
  return JSON.parse(body) as { slug: string; listed: boolean };
}
