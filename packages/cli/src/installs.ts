/**
 * `substrat installs <slug>` — the workspace's installs of one vertical, from the
 * DIRECTORY (#424 CLI parity). Before this, the only install signals a builder had
 * were `hostnames` (indirect) and the dashboard's toast; a scope stuck at
 * 'provisioning' was invisible from the CLI. One row per installed scope: name,
 * directory status, the hostname the router serves it on, and when it was created.
 * Forks (snapshots/previews) are not installs and are excluded.
 */
import { listVerticalHostnames } from './hostnames.js';
import { readAllEntries, readJson } from './http.js';
import { failureMessage } from './problem.js';

interface ScopeRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  vertical: string | null;
  verticalVersionId: string | null;
  forkedFrom: string | null;
  servingRef?: string | null;
  createdAt: string;
}

/** GET one control-plane page, reading a refusal as the problem document it is. */
async function getJson<T>(url: string, header: Record<string, string>): Promise<T> {
  const res = await fetch(url, { headers: header });
  if (!res.ok) {
    // The control plane answers a refused read with a problem document; print what it
    // says — the code and the detail — instead of a slice of the raw body (#971).
    throw new Error(failureMessage('control-plane read failed', res.status, await res.text().catch(() => res.statusText)));
  }
  return readJson<T>(res, url);
}

/**
 * List the tenant's installs of `slug`. The vertical match is tail-tolerant exactly
 * like `hostnames` (a staff push pinned to a tenant registers `<tenantSlug>/<slug>`
 * while everyone keeps SAYING the bare name), so the two commands always agree on
 * what an install of '<slug>' is.
 */
export async function printInstalls(
  controlPlaneUrl: string,
  header: Record<string, string>,
  tenantId: string,
  slug: string,
): Promise<void> {
  const base = controlPlaneUrl.replace(/\/$/, '');
  const scopes = await readAllEntries<ScopeRow>(
    `${base}/scopes?tenantId=${encodeURIComponent(tenantId)}`,
    (pageUrl) => getJson(pageUrl, header),
  );
  const installs = scopes
    .filter((s) => !s.forkedFrom && (s.vertical === slug || (s.vertical ?? '').endsWith(`/${slug}`)))
    .sort((a, b) => (a.id < b.id ? 1 : -1)); // ULIDs — newest first
  if (installs.length === 0) {
    console.log(`no installs of '${slug}' in this workspace — check the slug with \`substrat hostnames ${slug}\``);
    return;
  }
  // Join each install's served URL. Canonical-active first, any active as fallback.
  const bindings = await listVerticalHostnames(controlPlaneUrl, header, tenantId, slug).catch(() => []);
  const urlFor = (scopeId: string): string => {
    const own = bindings.filter((h) => h.scopeId === scopeId && h.status === 'active');
    return (own.find((h) => h.canonical) ?? own[0])?.hostname ?? '—';
  };

  const rows = installs.map((s) => [s.name, s.status, urlFor(s.id), s.id, s.createdAt.slice(0, 10)]);
  const headers = ['NAME', 'STATUS', 'HOSTNAME', 'SCOPE', 'CREATED'];
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const fmt = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
  console.log(fmt(headers));
  for (const r of rows) console.log(fmt(r));

  const stuck = installs.filter((s) => s.status === 'provisioning');
  if (stuck.length > 0) {
    console.log(
      `\n⚠ ${stuck.length} install(s) at 'provisioning' — inspect with \`substrat scope status <scopeId>\`;` +
        ` a stuck install resumes from the dashboard's Apps view.`,
    );
  }
}
