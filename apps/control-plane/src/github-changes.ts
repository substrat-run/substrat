/**
 * The open pull requests of one tenant's GitHub repository, each with its head's checks — the
 * GitHub half of `GET /verticals/:slug/changes`, injected into the control-plane API as its
 * `githubChanges` option. Reads only: each token is minted read-only for that one repository
 * and never leaves this function.
 *
 * The pull requests and their checks are read with two tokens, because an installation approved
 * before the App asked for checks and commit statuses refuses a token naming them. Such a
 * repository still lists its pull requests, each with its checks `unknown`, and says why.
 */
import { ControlPlaneError, gh, installationToken, type ControlPlaneApiOptions, type GithubChange, type GithubConfig } from '@substrat-run/control-plane-api';
import type { ChangeChecks } from '@substrat-run/contracts';

/** The most open pull requests one read lists, newest first. */
const PULLS_CAP = 30;
/** How many heads' checks are read at once: a cap on the fan-out, not on the list. */
const CHECKS_AT_ONCE = 6;
/** What listing the pull requests needs, and nothing that writes. */
const PULLS_READ = { metadata: 'read', pull_requests: 'read' } as const;
/** What reading their heads' checks needs besides. */
const CHECKS_READ = { metadata: 'read', checks: 'read', statuses: 'read' } as const;

type Read = ReturnType<NonNullable<ControlPlaneApiOptions['githubChanges']>>;

interface Pull {
  number: number;
  title: string;
  html_url: string;
  updated_at: string;
  user: { login: string } | null;
  head: { ref: string; sha: string };
}

/** A check run that did not pass. `neutral` and `skipped` are not failures. */
const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);

/** One head's checks: its check runs, else (none reported) its commit statuses. */
function checksOf(
  runs: readonly { name: string; status: string; conclusion: string | null }[],
  statuses: readonly { context: string; state: string }[],
): ChangeChecks {
  if (runs.length > 0) {
    const failing = runs.filter((r) => r.status === 'completed' && FAILED.has(r.conclusion ?? '')).map((r) => r.name);
    const pending = runs.some((r) => r.status !== 'completed');
    return { state: failing.length > 0 ? 'failure' : pending ? 'pending' : 'success', failing };
  }
  if (statuses.length === 0) return { state: 'none', failing: [] };
  const failing = statuses.filter((s) => s.state === 'failure' || s.state === 'error').map((s) => s.context);
  const pending = statuses.some((s) => s.state === 'pending');
  return { state: failing.length > 0 ? 'failure' : pending ? 'pending' : 'success', failing };
}

export async function readGithubChanges(cfg: GithubConfig, input: { owner: string; repo: string; installationId: string }): Read {
  const repository = `${input.owner}/${input.repo}`;
  const mint = (permissions: Readonly<Record<string, 'read'>>) =>
    installationToken(cfg, input.installationId, { name: input.repo, write: false, permissions }).catch(() => null);
  const read = async <T>(token: string, path: string): Promise<T> => {
    const res = await gh(cfg, `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}${path}`, `token ${token}`);
    if (!res.ok) throw new ControlPlaneError(502, `GitHub answered ${res.status} reading ${repository}`);
    return (await res.json()) as T;
  };
  const pullsToken = await mint(PULLS_READ);
  // Not granted the repository, or the installation predates reading pull requests.
  if (pullsToken === null) {
    return { unavailable: `the GitHub connection cannot read pull requests of ${repository}: grant the App that repository and approve its pull requests read permission` };
  }
  const pulls = await read<Pull[]>(pullsToken, `/pulls?state=open&sort=updated&direction=desc&per_page=${PULLS_CAP}`);
  const changeOf = (p: Pull, checks: ChangeChecks): GithubChange => ({
    number: p.number,
    id: `#${p.number}`,
    title: p.title,
    branch: p.head.ref,
    url: p.html_url,
    author: p.user?.login ?? null,
    updatedAt: p.updated_at,
    head: p.head.sha,
    checks,
  });
  const checksToken = pulls.length > 0 ? await mint(CHECKS_READ) : null;
  if (pulls.length > 0 && checksToken === null) {
    return {
      changes: pulls.map((p) => changeOf(p, { state: 'unknown', failing: [] })),
      reason: `the GitHub App cannot read checks for ${repository}: approve its checks and commit statuses read permissions`,
    };
  }
  const changes: GithubChange[] = new Array(pulls.length);
  for (let i = 0; i < pulls.length; i += CHECKS_AT_ONCE) {
    await Promise.all(pulls.slice(i, i + CHECKS_AT_ONCE).map(async (p, j) => {
      const sha = encodeURIComponent(p.head.sha);
      const runs = (await read<{ check_runs: { name: string; status: string; conclusion: string | null }[] }>(checksToken!, `/commits/${sha}/check-runs?per_page=100`)).check_runs;
      const statuses = runs.length > 0 ? [] : (await read<{ statuses: { context: string; state: string }[] }>(checksToken!, `/commits/${sha}/status`)).statuses;
      changes[i + j] = changeOf(p, checksOf(runs, statuses));
    }));
  }
  return { changes };
}
