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
import { ControlPlaneUsageError, type ControlPlaneBuilderClient } from '@substrat-run/control-plane-client';
import { parseJsonBody } from './http.js';
import { planeFor } from './plane.js';
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

/**
 * A create whose data is still being copied (#2450 step 2): the control plane answered 202, and
 * the same call, repeated, finishes the preview once the copy is done.
 */
interface PreviewCopying {
  copying: true;
  scopeId: string;
  versionId: string;
  progress: { pages: number; rows: number; attempt: number };
  /** Seconds to wait before calling again. */
  retryAfter: number;
}

const isCopying = (out: PreviewCreated | PreviewCopying): out is PreviewCopying =>
  (out as PreviewCopying).copying === true;

/** How long `preview create` waits for a copy before giving up, ms: the control plane's own job limit. */
export const PREVIEW_COPY_WAIT_MS = 6 * 3_600_000;

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
  plane: ControlPlaneBuilderClient,
  path: string,
  init?: RequestInit,
  opts: { retry?: Retry } = {},
): Promise<T> {
  const url = plane.urlFor(path);
  // A transient platform fault (#1918) is one retry away from working, and a CI job nobody
  // watches turns it into a red build. Only the callers that are idempotent by contract opt
  // in; a 4xx or any other status is a definite answer and is never retried. `Retry` says
  // how sure we must be that the first attempt is over before sending a second.
  const attempts = opts.retry ? 1 + RETRY_BACKOFF_MS.length : 1;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      // The raw exchange: this loop reads each attempt's status and body itself, and a network
      // failure must reach it as the error `fetch` threw, so it can tell the two apart.
      res = await plane.request(path, init);
    } catch (e) {
      // The client refused to send this request at all (it would have carried two credentials):
      // a mistake in the request, not a flaky network, so it is neither retried nor announced
      // as a retry. Keyed on its own class — `fetch` throws `TypeError` for a dropped connection.
      if (e instanceof ControlPlaneUsageError) throw e;
      // A network-level failure (no response at all) is the same transient class as a 502 —
      // for a call that is safe to repeat while the first is still running. A dropped
      // connection can come after the handler started, so a create does not retry on it.
      if (attempt >= attempts || opts.retry !== 'idempotent') throw e;
      await backoff(action, attempt, attempts, `network error: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    let body: string;
    try {
      body = await res.text();
    } catch (e) {
      // `fetch` resolves once headers arrive, so a drop while streaming the body rejects here,
      // not above. Same rule as a failed fetch: only a repeatable call retries. A definite
      // refusal (4xx, 500, 501) keeps its status rather than becoming a read error.
      if (res.ok || TRANSIENT_STATUS.has(res.status)) {
        if (attempt >= attempts || opts.retry !== 'idempotent') throw e;
        await backoff(action, attempt, attempts, `network error: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      body = '';
    }
    if (!res.ok) {
      const ref = /\breference\s*=\s*([a-z0-9]+)/i.exec(body)?.[1];
      if (attempt < attempts && shouldRetry(opts.retry, res.status, body)) {
        await backoff(action, attempt, attempts, `${res.status}${ref ? `, reference = ${ref}` : ''}`);
        continue;
      }
      throw new Error(failureMessage(action, res.status, body) + retriedInFlight(opts.retry, attempt, res.status, body));
    }
    return parseJsonBody<T>(body, url);
  }
}

/**
 * How sure a caller needs to be that the failed attempt is OVER before it sends another.
 * - `idempotent`: the call is safe to repeat even while the first is still running (read,
 *   delete) — any transient status will do.
 * - `after-handler-ended`: repeating while the first is still running is NOT useful. A create
 *   whose retry finds its row `provisioning` re-forks only once that create is over — its
 *   own frame marked it failed, or it is past the age bound (#1920) — and otherwise answers
 *   409. A bare 502/504 can be a gateway giving up on a handler that is still forking, so a
 *   retry on it would only read that 409.
 */
type Retry = 'idempotent' | 'after-handler-ended';

function shouldRetry(retry: Retry | undefined, status: number, body: string): boolean {
  if (!retry || !TRANSIENT_STATUS.has(status)) return false;
  if (retry === 'idempotent') return true;
  // 503: the request was refused before a handler ran, or the isolate running it was killed
  // (Cloudflare's 1102, resources exceeded). The redacted-fault shape is what Cloudflare
  // answers when the Worker's own invocation threw. Either way the handler that would still be
  // forking has ended. Anything else (a bare 502/504) may be a timeout in front of a live handler.
  return status === 503 || /\binternal error; reference\s*=\s*[a-z0-9]+/i.test(body);
}

/**
 * The line a RETRIED create adds to an in-flight 409 (#1920). The server refuses a tag whose
 * create is still `provisioning`, and a create that fails in its own request marks its row so
 * the retry is not refused. So a retry that is refused anyway most likely follows an attempt
 * that died without the chance to mark, such as a killed isolate. It can also be a different
 * create for the same tag that is still running.
 */
function retriedInFlight(retry: Retry | undefined, attempt: number, status: number, body: string): string {
  if (retry !== 'after-handler-ended' || attempt === 1 || status !== 409 || !/\bis in progress\b/.test(body)) return '';
  return (
    '\n  The earlier attempt of this create most likely died after its preview row landed; ' +
    '--refresh reclaims the tag now.'
  );
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
 * A preview call's client: the JSON content type on every request (reads and deletes too, as
 * the hand-rolled one sent it), and the stale-CLI nudge off every answer.
 */
const previewPlane = (opts: { controlPlaneUrl: string; header: Record<string, string> }): ControlPlaneBuilderClient =>
  planeFor(opts.controlPlaneUrl, opts.header, { advisory: true, contentType: 'application/json' });

/**
 * Create (or update) a preview. Idempotent on the tag: a second call with the same tag —
 * what a PR *synchronize* triggers — rebinds the new version onto the SAME fork, and the
 * control plane copies the fork's data into that version's deployment first (#1710), so the
 * PR's successive pushes roll their migrations forward on the same data (§4). It says so in
 * a `notes` line. `refresh` forces a clean fork from prod instead.
 *
 * A scope too large to copy in one request is copied in the background (#2450): the control plane
 * answers 202 with how far it got, and this calls again, printing that progress, until the
 * preview is ready.
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
  /** How long to wait for a copy that runs in the background (#2450), ms. */
  waitMs?: number;
  /** Default `setTimeout`; a test passes its own. */
  sleep?: (ms: number) => Promise<void>;
}): Promise<PreviewCreated> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const giveUpAt = Date.now() + (opts.waitMs ?? PREVIEW_COPY_WAIT_MS);
  for (let call = 1; ; call++) {
    const out = await request<PreviewCreated | PreviewCopying>(
      'preview create failed',
      previewPlane(opts),
      `/verticals/${encodeURIComponent(opts.slug)}/previews`,
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
          // The first call only: on a later one it would stop the copy this call started.
          ...(opts.refresh && call === 1 ? { refresh: true } : {}),
          // #2450 step 2: this client takes a 202 and calls again, so a copy too large for one
          // request runs in the background. A control plane that predates it ignores the field.
          async: true,
        }),
      },
      // Converges on the tag: a second call rebinds the same fork, and a create that died
      // half-built is reaped and re-forked, never duplicated. One still being built answers
      // 409 (#1920), so only retry once the first handler has ended.
      { retry: 'after-handler-ended' },
    );
    if (!isCopying(out)) return out;
    if (Date.now() >= giveUpAt) {
      throw new Error(
        `preview create failed: the preview's data was still being copied after ${Math.round((opts.waitMs ?? PREVIEW_COPY_WAIT_MS) / 60_000)} min ` +
          `(${out.progress.pages} pages so far). The copy goes on; run the same command again to pick it up.`,
      );
    }
    const attempt = out.progress.attempt > 1 ? `, attempt ${out.progress.attempt}: the source changed while it was read` : '';
    console.warn(`preview create: copying the preview's data (${out.progress.pages} pages, ${out.progress.rows} rows so far${attempt})`);
    await sleep(Math.max(1, out.retryAfter) * 1000);
  }
}

/** Reap a preview by tag. Idempotent: an already-gone preview is a no-op success, so a
 *  PR-close job never fails because the preview was already removed. */
export async function deletePreview(opts: {
  controlPlaneUrl: string;
  header: Record<string, string>;
  slug: string;
  tag: string;
}): Promise<{ deleted: string | null }> {
  return request<{ deleted: string | null }>(
    'preview delete failed',
    previewPlane(opts),
    `/verticals/${encodeURIComponent(opts.slug)}/previews/${encodeURIComponent(opts.tag)}`,
    { method: 'DELETE' },
    // The route answers 200 `{ deleted: null }` for a preview already gone, so a retry after a
    // delete that landed but whose response was lost succeeds rather than failing on a 404.
    { retry: 'idempotent' },
  );
}

export async function listPreviews(opts: {
  controlPlaneUrl: string;
  header: Record<string, string>;
  slug: string;
}): Promise<PreviewRow[]> {
  return request<PreviewRow[]>(
    'preview list failed',
    previewPlane(opts),
    `/verticals/${encodeURIComponent(opts.slug)}/previews`,
    undefined,
    { retry: 'idempotent' },
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
