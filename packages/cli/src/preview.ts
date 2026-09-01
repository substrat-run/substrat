/**
 * `substrat preview` — per-PR preview instances of a PRIVATE vertical
 * (preview-and-snapshots.md §2/§9). A preview forks the tenant's prod scope, binds the
 * PR's just-pushed version to the fork, and serves it on its own `--<tag>` URL; closing
 * the PR reaps it (and a TTL is the GC backstop for an abandoned one).
 *
 * `create` pushes the working tree first (reusing `push()`), so the version it binds is
 * exactly the PR's code — a private vertical's push self-admits, so the bind is a pure
 * self-serve act. The slug is BARE; the control plane forms `<tenantSlug>/<slug>` from
 * the caller's tenant (§5), so a builder never types their own prefix. Auth is the same
 * tenant-scoped push token CI already carries.
 */
import { warnIfStale } from './version.js';
import { parseJsonBody } from './http.js';
import { failureMessage } from './problem.js';

export interface PreviewCreated {
  scopeId: string;
  hostname: string;
  url: string;
  versionId: string;
  reused: boolean;
}

export interface PreviewRow {
  scopeId: string;
  tag: string | null;
  versionId: string | null;
  forkedFrom: string | null;
  expiresAt: string | null;
  hostname: string | null;
  url: string | null;
}

/**
 * One request, and one reader for what a refusal said (#971).
 *
 * `failureMessage` is the CLI's shared reader: a problem document, the deprecated
 * `{ error }` duplicate, and the pre-#113 `{ error, issues }` Zod refusal all arrive as
 * the same message here as they do from `push` or `promote` — so a preview 400 names the
 * field it refused, and which command a builder ran stops changing the shape of the answer.
 */
async function request<T>(action: string, url: string, header: Record<string, string>, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...header } });
  warnIfStale(res.headers);
  const body = await res.text();
  if (!res.ok) throw new Error(failureMessage(action, res.status, body));
  return parseJsonBody<T>(body, url);
}

/**
 * Create (or update) a preview. Idempotent on the tag: a second call with the same tag —
 * what a PR *synchronize* triggers — rebinds the new version onto the SAME fork so the
 * PR's successive pushes roll their migrations forward on one copy (§4). `refresh` forces
 * a clean fork from prod instead.
 */
export async function createPreview(opts: {
  controlPlaneUrl: string;
  header: Record<string, string>;
  slug: string;
  tag: string;
  versionId: string;
  sourceScopeId?: string;
  empty?: boolean;
  ttlHours?: number | null;
  surface?: string;
  refresh?: boolean;
}): Promise<PreviewCreated> {
  const base = opts.controlPlaneUrl.replace(/\/$/, '');
  return request<PreviewCreated>(
    'preview create failed',
    `${base}/verticals/${encodeURIComponent(opts.slug)}/previews`,
    opts.header,
    {
      method: 'POST',
      body: JSON.stringify({
        tag: opts.tag,
        versionId: opts.versionId,
        ...(opts.empty ? { empty: true } : {}),
        ...(opts.sourceScopeId ? { sourceScopeId: opts.sourceScopeId } : {}),
        // `null` (pinned) must reach the wire, so send whenever a value was given — not just truthy.
        ...(opts.ttlHours !== undefined ? { ttlHours: opts.ttlHours } : {}),
        ...(opts.surface ? { surface: opts.surface } : {}),
        ...(opts.refresh ? { refresh: true } : {}),
      }),
    },
  );
}

/** Reap a preview by tag. Idempotent: an already-gone preview is a no-op success, so a
 *  PR-close job never fails because the preview was already removed. */
export async function deletePreview(opts: {
  controlPlaneUrl: string;
  header: Record<string, string>;
  slug: string;
  tag: string;
}): Promise<{ deleted: string | null }> {
  const base = opts.controlPlaneUrl.replace(/\/$/, '');
  return request<{ deleted: string | null }>(
    'preview delete failed',
    `${base}/verticals/${encodeURIComponent(opts.slug)}/previews/${encodeURIComponent(opts.tag)}`,
    opts.header,
    { method: 'DELETE' },
  );
}

export async function listPreviews(opts: {
  controlPlaneUrl: string;
  header: Record<string, string>;
  slug: string;
}): Promise<PreviewRow[]> {
  const base = opts.controlPlaneUrl.replace(/\/$/, '');
  return request<PreviewRow[]>(
    'preview list failed',
    `${base}/verticals/${encodeURIComponent(opts.slug)}/previews`,
    opts.header,
  );
}

/** Render previews as an aligned table (the `substrat preview ls` output). */
export function formatPreviews(rows: PreviewRow[]): string {
  if (rows.length === 0) return '(no active previews)';
  const width = Math.max(...rows.map((r) => (r.hostname ?? '').length), 1);
  return rows
    .map((r) =>
      [
        (r.tag ?? '?').padEnd(10),
        (r.hostname ?? '(no url)').padEnd(width),
        (r.versionId ?? '?').padEnd(28),
        r.expiresAt ? `expires ${r.expiresAt}` : 'pinned',
      ].join('  '),
    )
    .join('\n');
}

/**
 * Parse a `--ttl` value like `72h`, `3d`, or a bare number of hours → hours. The literal
 * `none`/`pinned` returns `null` — a preview kept alive until it is deliberately deleted
 * (a long-lived `--tag dev` environment), distinct from `undefined` = the 72h default.
 */
export function parseTtlHours(raw: string | undefined): number | null | undefined {
  if (!raw) return undefined;
  const t = raw.trim().toLowerCase();
  if (t === 'none' || t === 'pinned') return null;
  const m = /^(\d+)\s*([hd])?$/.exec(t);
  if (!m) throw new Error(`invalid --ttl '${raw}' — use e.g. 72h, 3d, or none`);
  const n = Number(m[1]);
  return m[2] === 'd' ? n * 24 : n;
}
