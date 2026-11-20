/**
 * GitHub App webhook boundary — the pure half (signature check, event parse).
 * The App delivers ONE webhook stream for every installation; the worker route
 * verifies + parses here, then hands the event to the repo's `GithubRepoLinkDO`
 * (worker.ts), which owns the stateful part: waiting for the PR's CI to land its
 * preview, posting the URLs on the PR, reaping on close.
 *
 * The comment bodies and preview tag conventions this file used to own now live in
 * `@substrat-run/contracts` (`ci.ts`) — the generated workflow writes the same
 * comment from the CI side, and one generator for both is the only way they cannot
 * drift. Re-exported here so the worker's imports stay in one place.
 *
 * Kept free of Cloudflare imports so it compiles (and tests) under the node
 * tsconfig — the same split as github.ts.
 */
import { PREVIEW_LABEL, fileMatchesWorkflowPaths, z, type PreviewMode } from '@substrat-run/contracts';

export {
  PREVIEW_COMMENT_MARKER,
  previewTag,
  buildPreviewTag,
  buildPreviewTagPrefix,
  previewCommentBody,
  previewReapedBody,
  previewRequestBody,
  PREVIEW_LABEL,
  PREVIEW_MODES,
  type PreviewMode,
} from '@substrat-run/contracts';

/**
 * Verify GitHub's `X-Hub-Signature-256` header against the RAW request body.
 * HMAC-SHA256 over the exact bytes, hex, prefixed `sha256=`; compared in
 * constant time (accumulated XOR — `crypto.subtle` has no portable
 * timing-safe compare across workerd and node).
 */
export async function verifyGithubSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string | null | undefined,
): Promise<boolean> {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody)));
  const expected = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
  const given = signatureHeader.slice('sha256='.length).toLowerCase();
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

// The slice of GitHub's pull_request payload the platform acts on. `installation`
// is present on every App-delivered event and is what lets the DO mint tokens
// later WITHOUT storing an installation id per repo — the webhook always carries
// the current one.
const pullRequestPayload = z.object({
  action: z.string(),
  number: z.number().int().positive(),
  repository: z.object({ full_name: z.string().regex(/^[^/\s]+\/[^/\s]+$/) }),
  installation: z.object({ id: z.union([z.number().int(), z.string()]) }),
  // The labels decide an `on-request` repo's preview; absent reads as none, never a refusal.
  pull_request: z.object({ labels: z.array(z.object({ name: z.string() })).optional() }).optional(),
  // Present on a `labeled` delivery: the one label that was just added.
  label: z.object({ name: z.string() }).optional(),
});

export interface PullRequestEvent {
  /**
   * `sync` = opened/reopened/synchronize (arm the preview watch); `closed` = reap;
   * `labeled` = a label was added (`label` names it), which is how an `on-request` repo
   * asks for its preview.
   */
  action: 'sync' | 'closed' | 'labeled';
  /** `opened`/`reopened`: the moment an `on-request` repo's PR gets its "No preview yet" comment. */
  opened: boolean;
  /** Every label on the PR as delivered, the just-added one included. */
  labels: string[];
  /** The label a `labeled` delivery added. */
  label?: string;
  /** `owner/name`, exactly as GitHub reports it. */
  repo: string;
  prNumber: number;
  /** The App installation that delivered the event — mints the comment token. */
  installationId: string;
}

/**
 * Parse a webhook delivery into the one event shape the platform handles, or
 * `null` for everything else (other event types, other actions, payloads that
 * don't parse). `null` means "acknowledge and ignore" — a webhook is a nudge,
 * not a fact, so unknown deliveries are dropped without error.
 */
export function parsePullRequestWebhook(eventName: string, rawBody: string): PullRequestEvent | null {
  if (eventName !== 'pull_request') return null;
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const parsed = pullRequestPayload.safeParse(json);
  if (!parsed.success) return null;
  const { action, number, repository, installation, pull_request, label } = parsed.data;
  const kind =
    action === 'opened' || action === 'reopened' || action === 'synchronize'
      ? ('sync' as const)
      : action === 'closed'
        ? ('closed' as const)
        : action === 'labeled' && label
          ? ('labeled' as const)
          : null;
  if (!kind) return null;
  return {
    action: kind,
    repo: repository.full_name,
    prNumber: number,
    installationId: String(installation.id),
    opened: action === 'opened' || action === 'reopened',
    labels: (pull_request?.labels ?? []).map((l) => l.name),
    ...(kind === 'labeled' && label ? { label: label.name } : {}),
  };
}

/** What the repo's link DO does with one PR event. */
export type PreviewAction = 'reap' | 'watch' | 'ask' | 'ignore';

/**
 * Decide a PR event against the repo's preview mode — the whole policy, pure, so the DO
 * only carries it out.
 *
 * - `reap` on close, in either mode: a PR whose label was removed may still hold a preview.
 * - `watch`: CI is building (or rebuilding) this PR's preview, so poll the control plane
 *   until it lands and then comment its URL. In `every-pr` that is every open/push. In
 *   `on-request` it is a push to a PR carrying the label, or the label being added.
 * - `ask`: an `on-request` PR without the label was opened (or reopened), so it gets the
 *   "No preview yet" comment with the Build preview link. A later push to it does nothing.
 * - `ignore`: everything else, an unrelated label among it.
 */
export function previewActionFor(
  mode: PreviewMode,
  evt: Pick<PullRequestEvent, 'action' | 'opened' | 'labels' | 'label'>,
): PreviewAction {
  if (evt.action === 'closed') return 'reap';
  if (mode === 'every-pr') return evt.action === 'sync' ? 'watch' : 'ignore';
  if (evt.action === 'labeled') return evt.label === PREVIEW_LABEL ? 'watch' : 'ignore';
  if (evt.labels.includes(PREVIEW_LABEL)) return 'watch';
  return evt.opened ? 'ask' : 'ignore';
}

/**
 * The dashboard page a "No preview yet" comment links to. Team-less in its path because the
 * comment is written by the repo's link DO, which knows the tenant id and not the team's URL
 * slug; the page reads the team from `team` and every call it makes names that team in its
 * own URL, so membership is checked where it always is.
 */
export function previewRequestUrl(origin: string, tenantId: string, repo: string, prNumber: number): string {
  const q = new URLSearchParams({ team: tenantId, repo, pr: String(prNumber) });
  return `${origin.replace(/\/+$/, '')}/preview-request?${q.toString()}`;
}

/**
 * The preview mode one-click setup commits and stores, in order:
 *
 * 1. what the person chose in this request;
 * 2. what the repo's link already holds — a link stored before the mode existed was set up
 *    when every PR previewed, so `stored` arrives here as `every-pr` for it;
 * 3. `every-pr` when the repo already carried the workflow file: it was set up before links
 *    existed at all (or by hand), its PRs preview today, and re-running setup must not take
 *    that away silently;
 * 4. `on-request` for a repo set up for the first time.
 */
export function resolvePreviewMode(input: {
  requested?: PreviewMode | undefined;
  stored?: PreviewMode | undefined;
  workflowExisted: boolean;
}): PreviewMode {
  return input.requested ?? input.stored ?? (input.workflowExisted ? 'every-pr' : 'on-request');
}

/**
 * Whether a PR can start the repo's workflow at all, which is what decides if its "No
 * preview yet" comment may offer Build preview: in a monorepo the workflow is filtered to the
 * vertical's package (`workflowPathFilters`), and a PR changing only other packages, a
 * dependency bump among them, never starts it, label or not. A link that leads nowhere would
 * say "Building…" for thirty minutes and give up.
 *
 * `path` is what setup stored on the repo's link: `null` for a vertical at the repo root
 * (every PR reaches the workflow), a directory for a monorepo package, and `undefined` for a
 * link stored before setup recorded it, which says nothing either way, so no comment. Files
 * are only listed when the answer depends on them, and a failed listing is a no.
 */
export async function prReachesWorkflow(path: string | null | undefined, listFiles: () => Promise<string[]>): Promise<boolean> {
  if (path === undefined) return false;
  if (path === null) return true;
  const files = await listFiles().catch(() => null);
  return files !== null && files.some((f) => fileMatchesWorkflowPaths(f, path));
}
