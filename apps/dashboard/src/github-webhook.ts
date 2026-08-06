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
import { z } from '@substrat-run/contracts';

export {
  PREVIEW_COMMENT_MARKER,
  previewTag,
  buildPreviewTag,
  buildPreviewTagPrefix,
  previewCommentBody,
  previewReapedBody,
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
});

export interface PullRequestEvent {
  /** `sync` = opened/reopened/synchronize (arm the preview watch); `closed` = reap. */
  action: 'sync' | 'closed';
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
  const { action, number, repository, installation } = parsed.data;
  const kind =
    action === 'opened' || action === 'reopened' || action === 'synchronize'
      ? ('sync' as const)
      : action === 'closed'
        ? ('closed' as const)
        : null;
  if (!kind) return null;
  return { action: kind, repo: repository.full_name, prNumber: number, installationId: String(installation.id) };
}
