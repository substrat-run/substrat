/**
 * `substrat versions <slug>` — list a vertical's versions and which channels point at
 * them. Read-only builder visibility: the first slice of letting a builder see the
 * verticals they pushed without the staff console. It calls the existing registry
 * endpoints (`/verticals/:slug/versions`, `/channels`); today those are staff-gated, so
 * this works for staff now and for builders once builder-scoped authz lands.
 */
import { listVerticalHostnames } from './hostnames.js';

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
    throw new Error(`${res.status} ${(await res.text().catch(() => res.statusText)).slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
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
  const versions = await getJson<Version[]>(`${base}/verticals/${encodeURIComponent(slug)}/versions`, header);
  // Channels are best-effort — a vertical with none registered still lists its versions.
  const channels = await getJson<Channel[]>(`${base}/verticals/${encodeURIComponent(slug)}/channels`, header).catch(
    () => [] as Channel[],
  );

  if (versions.length === 0) {
    // Distinguish "no versions" from the #399 lineage fork: if installs (hostnames) are
    // bound to this slug yet nothing was pushed under it, the versions live under another
    // slug. `substrat push` derives its slug from package.json `name` unless `substrat.slug`
    // pins it, so a rename or a scope mismatch silently forks the lineage.
    let installs = 0;
    if (tenantId) {
      const rows = await listVerticalHostnames(controlPlaneUrl, header, tenantId, slug).catch(() => []);
      installs = rows.length;
    }
    if (installs > 0) {
      console.log(
        `no versions are registered under '${slug}', but ${installs} hostname(s) are bound to it.\n` +
          `⚠ This is a lineage fork: the installs live under '${slug}', but pushes landed under a DIFFERENT slug.\n` +
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
