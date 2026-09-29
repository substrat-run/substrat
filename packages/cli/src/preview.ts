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
import { oidcCallbackUrl, type PreviewAuth } from '@substrat-run/contracts';
import { warnIfStale } from './version.js';
import { parseJsonBody } from './http.js';
import { failureMessage } from './problem.js';

export interface PreviewCreated {
  scopeId: string;
  hostname: string;
  url: string;
  versionId: string;
  reused: boolean;
  /**
   * What happened to the preview's login (#1704). Absent from a control plane that predates
   * it — which also means nothing was done about the login at all.
   */
  auth?: PreviewAuth;
  /** What a preview does not carry over from the app it forks. */
  notes?: string[];
}

export interface PreviewRow {
  scopeId: string;
  tag: string | null;
  versionId: string | null;
  forkedFrom: string | null;
  expiresAt: string | null;
  hostname: string | null;
  url: string | null;
  /** The preview's OIDC callback — what an external issuer would need registered (#1704). */
  callbackUrl?: string | null;
}

/**
 * The lines `preview create` prints about the preview's login and what it did not carry over
 * (#1704). Every status gets a line, so a preview without a working login is never silent —
 * and one that could not be wired is marked, since its URL still opens.
 */
export function formatPreviewLogin(created: PreviewCreated): string[] {
  const lines: string[] = [];
  const auth = created.auth;
  if (!auth) {
    lines.push(
      '  ⚠ Sign-in: this control plane predates preview logins, so nothing was delivered for one. ' +
        `If the app signs in with OIDC, its callback here is ${oidcCallbackUrl(created.hostname)}.`,
    );
  } else {
    const warn = auth.status === 'unregistered' || auth.status === 'ambiguous' || auth.status === 'unknown';
    lines.push(`  ${warn ? '⚠ ' : ''}${auth.note}`);
  }
  for (const note of created.notes ?? []) lines.push(`  ${note}`);
  return lines;
}

/**
 * One request, and one reader for what a refusal said (#971).
 *
 * `failureMessage` is the CLI's shared reader: a problem document, the deprecated
 * `{ error }` duplicate, and the pre-#113 `{ error, issues }` Zod refusal all arrive as
 * the same message here as they do from `push` or `promote` — so a preview 400 names the
 * field it refused, and which command a builder ran stops changing the shape of the answer.
 */
async function request<T>(
  action: string,
  url: string,
  header: Record<string, string>,
  init?: RequestInit,
  opts: { retry?: boolean } = {},
): Promise<T> {
  // A transient platform fault (#1918) is one retry away from working, and a CI job nobody
  // watches turns it into a red build. Only the callers that are idempotent by contract opt
  // in; a 4xx or any other status is a definite answer and is never retried.
  const attempts = opts.retry ? 1 + RETRY_BACKOFF_MS.length : 1;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...header } });
    } catch (e) {
      // A network-level failure (no response at all) is the same transient class as a 502.
      if (attempt >= attempts) throw e;
      await backoff(action, attempt, attempts, `network error: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    warnIfStale(res.headers);
    const body = await res.text();
    if (!res.ok) {
      if (TRANSIENT_STATUS.has(res.status) && attempt < attempts) {
        const ref = /\breference\s*=\s*([a-z0-9]+)/i.exec(body)?.[1];
        await backoff(action, attempt, attempts, `${res.status}${ref ? `, reference = ${ref}` : ''}`);
        continue;
      }
      throw new Error(failureMessage(action, res.status, body));
    }
    return parseJsonBody<T>(body, url);
  }
}

/** The statuses `explainPlatformFault` calls momentary: the gateway or upstream, not the request. */
const TRANSIENT_STATUS: ReadonlySet<number> = new Set([502, 503, 504]);
/** The wait before each further attempt — two extra attempts, bounded. */
const RETRY_BACKOFF_MS = [1_000, 3_000] as const;

/** Say the retry happened (one line per attempt, reference kept), then wait. */
async function backoff(action: string, attempt: number, attempts: number, why: string): Promise<void> {
  const wait = RETRY_BACKOFF_MS[attempt - 1]!;
  console.warn(`${action} (${why}); retrying in ${wait / 1000}s (attempt ${attempt + 1} of ${attempts})`);
  await new Promise((resolve) => setTimeout(resolve, wait));
}

/**
 * Create (or update) a preview. Idempotent on the tag: a second call with the same tag —
 * what a PR *synchronize* triggers — rebinds the new version onto the SAME fork, and the
 * control plane copies the fork's data into that version's deployment first (#1710), so the
 * PR's successive pushes roll their migrations forward on the same data (§4). It says so in
 * a `notes` line. `refresh` forces a clean fork from prod instead.
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
    // Safe to retry: the control plane converges on the tag — a second call rebinds the same
    // fork, and a create that died half-built is reaped and re-forked, never duplicated.
    { retry: true },
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
    { retry: true },
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
    undefined,
    { retry: true },
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
