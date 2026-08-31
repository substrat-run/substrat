/**
 * `substrat versions <slug>` — list a vertical's versions and which channels point at
 * them. Read-only builder visibility: the first slice of letting a builder see the
 * verticals they pushed without the staff console. It calls the existing registry
 * endpoints (`/verticals/:slug/versions`, `/channels`); today those are staff-gated, so
 * this works for staff now and for builders once builder-scoped authz lands.
 */
import { listVerticalHostnames } from './hostnames.js';
import { readAllEntries, readJson } from './http.js';
import { failureMessage } from './problem.js';

interface Version {
  id: string;
  version: string;
  admission: string;
  deploymentRef?: string;
}
interface Channel {
  channel: string;
  versionId: string;
  // What prod's stable serving script actually runs (#286/#321). Differs from versionId
  // when an in-place serve failed: the channel was promoted but the scopes run old code.
  servingVersionId?: string | null;
}

async function getJson<T>(url: string, header: Record<string, string>): Promise<T> {
  const res = await fetch(url, { headers: header });
  if (!res.ok) {
    // The control plane answers a refused read with a problem document; print what it
    // says — the code and the detail — instead of a slice of the raw body (#971).
    throw new Error(failureMessage('control-plane read failed', res.status, await res.text().catch(() => res.statusText)));
  }
  return readJson<T>(res, url);
}

/** Walk a paged list route to the end (the CLI wants the whole list, not a screenful). */
const getAll = <T>(url: string, header: Record<string, string>): Promise<T[]> =>
  readAllEntries<T>(url, (pageUrl) => getJson(pageUrl, header));

/**
 * Resolve the registry identity `versions <slug>` should read (#399): the exact slug
 * when it has versions, else — with exactly the tail-tolerance `hostnames` already
 * applies (`verticalSlug.endsWith('/' + slug)`) — a workspace-prefixed registration of
 * the same product name. A staff push pinned to a tenant registers the vertical as
 * `<tenantSlug>/<name>` while everyone keeps SAYING the bare name, so before this the
 * two commands disagreed: `hostnames egeryds-substrat` listed the installs while
 * `versions egeryds-substrat` printed the (wrong, alarming) lineage-fork hint. Returns
 * which slug was read and a note when it differs from what was asked.
 */
async function resolveVersionsSlug(
  base: string,
  header: Record<string, string>,
  slug: string,
): Promise<{ slug: string; versions: Version[]; note?: string; ambiguous?: string[] }> {
  const exact = await getAll<Version>(`${base}/verticals/${encodeURIComponent(slug)}/versions`, header);
  if (exact.length > 0) return { slug, versions: exact };
  // The registry list is visibility-scoped server-side (staff: all; builder: own), so a
  // tail match never reveals a foreign tenant's registration the caller couldn't read.
  const registry = await getAll<{ slug: string }>(`${base}/verticals`, header).catch(
    () => [] as Array<{ slug: string }>,
  );
  const candidates = registry.filter((v) => v.slug !== slug && v.slug.endsWith(`/${slug}`));
  const withVersions: Array<{ slug: string; versions: Version[] }> = [];
  for (const c of candidates) {
    const versions = await getAll<Version>(`${base}/verticals/${encodeURIComponent(c.slug)}/versions`, header).catch(
      () => [] as Version[],
    );
    if (versions.length > 0) withVersions.push({ slug: c.slug, versions });
  }
  if (withVersions.length === 1) {
    const hit = withVersions[0]!;
    return {
      slug: hit.slug,
      versions: hit.versions,
      note: `showing '${hit.slug}' — the workspace-prefixed registration of '${slug}' (pushes and hostnames use this identity)`,
    };
  }
  if (withVersions.length > 1) {
    return { slug, versions: [], ambiguous: withVersions.map((v) => v.slug) };
  }
  return { slug, versions: [] };
}

export async function printVersions(
  controlPlaneUrl: string,
  header: Record<string, string>,
  slug: string,
  // Optional so `versions` can cross-check installs against versions (#399): a slug with
  // bound hostnames but zero versions is the tell that pushes landed under a DIFFERENT
  // slug. Absent (no --tenant) ⇒ the cross-check is skipped and the hint stays generic.
  tenantId?: string,
): Promise<void> {
  const base = controlPlaneUrl.replace(/\/$/, '');
  const resolved = await resolveVersionsSlug(base, header, slug);
  if (resolved.note) console.log(resolved.note);
  if (resolved.ambiguous) {
    console.log(
      `no versions are registered under '${slug}', but several workspace-prefixed registrations of it have versions:\n` +
        resolved.ambiguous.map((s) => `  substrat versions ${s}`).join('\n'),
    );
    return;
  }
  const { versions } = resolved;
  // Channels are best-effort — a vertical with none registered still lists its versions.
  const channels = await getAll<Channel>(
    `${base}/verticals/${encodeURIComponent(resolved.slug)}/channels`,
    header,
  ).catch(() => [] as Channel[]);

  if (versions.length === 0) {
    // Distinguish "no versions" from the #399 lineage fork: if installs (hostnames) are
    // bound to this slug yet nothing was pushed under it, the versions live under another
    // slug. `substrat push` derives its slug from package.json `name` unless `substrat.slug`
    // pins it, so a rename or a scope mismatch silently forks the lineage.
    let installs = 0;
    let installSlugs: string[] = [];
    if (tenantId) {
      const rows = await listVerticalHostnames(controlPlaneUrl, header, tenantId, slug).catch(
        () => [] as Array<{ verticalSlug?: string | null }>,
      );
      installs = rows.length;
      // The hostname rows carry the slug the installs are REALLY registered under —
      // when it differs from what was asked, the fix is a rename away, so name it.
      installSlugs = [...new Set(rows.map((r) => r.verticalSlug).filter((s): s is string => !!s && s !== slug))];
    }
    if (installs > 0) {
      console.log(
        `no versions are registered under '${slug}', but ${installs} hostname(s) are bound to it` +
          (installSlugs.length ? ` (install identity: ${installSlugs.map((s) => `'${s}'`).join(', ')})` : '') +
          `.\n⚠ This is a lineage fork: the installs and the pushes are on different slugs.\n` +
          `  \`substrat push\` derives its slug from package.json \`name\` unless \`substrat.slug\` pins it — check both,\n` +
          `  and run \`substrat versions <the-other-slug>\` to find where the versions went.`,
      );
    } else if (tenantId) {
      console.log(`no versions for '${slug}', and no installs are bound to it in this workspace — is the slug correct?`);
    } else {
      console.log(
        `no versions for '${slug}' (or they aren't visible to you). ` +
          `If installs serve under this slug, pass --tenant to cross-check for a lineage fork (#399).`,
      );
    }
    return;
  }

  // A prod promote whose in-place serve failed leaves the channel pointing at the new
  // version while the scopes still run the old one (#321). Report the SERVING truth, and
  // flag the divergence, rather than labelling the promoted-but-not-live version 'prod'.
  const prod = channels.find((c) => c.channel === 'prod');
  const serving = prod?.servingVersionId ?? null;
  const stalled = prod && serving !== null && serving !== prod.versionId;

  const byVersion = new Map<string, string[]>();
  const tag = (versionId: string, label: string) => {
    const list = byVersion.get(versionId) ?? [];
    list.push(label);
    byVersion.set(versionId, list);
  };
  for (const c of channels) {
    if (c.channel === 'prod' && stalled) {
      tag(c.versionId, 'prod(promoted)'); // moved the pointer, but not serving
      if (serving) tag(serving, 'prod(serving)'); // what the scopes actually run
    } else {
      tag(c.versionId, c.channel);
    }
  }

  // Newest first (the id is a ULID — lexicographic order is chronological).
  const rows = [...versions]
    .sort((a, b) => (a.id < b.id ? 1 : -1))
    .map((v) => [v.version, v.admission, (byVersion.get(v.id) ?? []).join(',') || '—', v.id]);

  const headers = ['VERSION', 'ADMISSION', 'CHANNELS', 'ID'];
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const fmt = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
  console.log(fmt(headers));
  for (const r of rows) console.log(fmt(r));
  if (stalled) {
    console.log(
      `\n⚠ prod: version ${prod!.versionId} is promoted but NOT serving — the in-place serve failed,\n` +
        `  scopes still run ${serving}. Promote prod again to retry the serve.`,
    );
  }
}
