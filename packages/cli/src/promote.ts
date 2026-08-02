/**
 * `substrat promote <slug> --channel dev|staging|prod --version <id>` — a builder
 * self-serves its channels: dev/staging always, and prod while the vertical is PRIVATE
 * (builder-plane.md §4-revised; a listed vertical's prod is a staff decision again —
 * the control plane refuses it). The slug is BARE — the control plane forms
 * `<tenantSlug>/<slug>` from the caller's tenant (§5), so a builder never types their
 * own prefix. Only admitted versions promote; a changed digest is refused without
 * acknowledgement (the two checkpoints), surfaced as a 4xx here — re-run with
 * `--ack-permissions` / `--ack-migrations` after reading the named diff.
 */
import { warnIfStale } from './version.js';
import { parseJsonBody } from './http.js';

export interface PromoteOptions {
  controlPlaneUrl: string;
  header: Record<string, string>;
  slug: string;
  channel: string;
  versionId: string;
  acknowledge?: { permissionChange?: boolean; migrationChange?: boolean };
}

export async function promote(opts: PromoteOptions): Promise<{ channel: string; versionId: string }> {
  const base = opts.controlPlaneUrl.replace(/\/$/, '');
  const url = `${base}/verticals/${encodeURIComponent(opts.slug)}/channels/${encodeURIComponent(opts.channel)}/promote`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...opts.header, 'content-type': 'application/json' },
    body: JSON.stringify({
      versionId: opts.versionId,
      ...(opts.acknowledge ? { acknowledge: opts.acknowledge } : {}),
    }),
  });
  warnIfStale(res.headers);
  const body = await res.text();
  if (!res.ok) throw new Error(`promote failed (${res.status}): ${body.slice(0, 300)}`);
  return parseJsonBody<{ channel: string; versionId: string }>(body, url);
}
