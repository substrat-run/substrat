import { PNPM_LOCKFILE_REQUIRED, type ProjectRepository } from '@substrat-run/contracts';
import type { SandboxLike } from '@substrat-run/builder-workspace/edge';
import { CommandFailedError, SourceBuildError } from './problem.js';

/** Binding slice from Cloudflare's Artifacts Workers API. No provider type leaks into projects. */
export interface ArtifactRepositories {
  create(name: string, opts: { setDefaultBranch: string }): Promise<{ name: string; remote: string }>;
  get(name: string): Promise<{
    info(): Promise<{ remote: string }>;
    createToken(scope: 'read' | 'write', ttl: number): Promise<{ plaintext: string }>;
    [Symbol.dispose](): void;
  }>;
}

export interface RepositoryAccess { remote: string; authorization: string }
export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'"'"'`)}'`;

export async function repositoryAccess(
  artifacts: ArtifactRepositories,
  repository: ProjectRepository,
  scope: 'read' | 'write',
  github: (owner: string, repo: string, scope: 'read' | 'write') => Promise<{ remote: string; token: string }>,
): Promise<RepositoryAccess> {
  if (repository.kind === 'github') {
    const access = await github(repository.owner, repository.repo, scope);
    return { remote: access.remote, authorization: `Basic ${btoa(`x-access-token:${access.token}`)}` };
  }
  const handle = await artifacts.get(repository.name);
  try {
    const [info, token] = await Promise.all([handle.info(), handle.createToken(scope, 600)]);
    const remote = new URL(info.remote);
    if (remote.protocol !== 'https:' || !remote.hostname.endsWith('.artifacts.cloudflare.net') || remote.username || remote.password) {
      throw new Error('Artifacts returned an invalid Git remote');
    }
    return { remote: info.remote, authorization: `Bearer ${token.plaintext}` };
  } finally {
    handle[Symbol.dispose]();
  }
}

/** Credentials exist only for the Git invocation; never stored in remotes or build env. */
export async function repositoryGit(sb: SandboxLike, access: RepositoryAccess, args: string[], cwd?: string): Promise<string> {
  if (/[\r\n]/.test(access.authorization)) throw new Error('invalid repository credential');
  const file = `/tmp/substrat-git-${crypto.randomUUID()}`;
  await sb.writeFile(file, `Authorization: ${access.authorization}`);
  try {
    const r = await sb.exec(
      `GIT_TERMINAL_PROMPT=0 git -c credential.helper= -c core.hooksPath=/dev/null -c http.extraHeader="$(cat ${shellQuote(file)})" ${args.map(shellQuote).join(' ')}`,
      cwd ? { cwd } : undefined,
    );
    // Git errors can include authenticated HTTP diagnostics. Do not propagate those logs.
    if (r.exitCode !== 0) throw new SourceBuildError('repository operation failed; check access and whether the branch changed');
    return r.stdout.trim();
  } finally {
    await sb.exec(`rm -f ${shellQuote(file)}`);
  }
}

export async function checkedExec(sb: SandboxLike, command: string, cwd?: string): Promise<string> {
  const r = await sb.exec(command, cwd ? { cwd } : undefined);
  if (r.exitCode !== 0) throw new CommandFailedError(`command failed: ${(r.stderr || r.stdout).slice(-6000)}`);
  return r.stdout.trim();
}

/** The push refuses this first; a studio revision and an older CLI reach only this one. */
export async function assertPnpmLockfile(sb: SandboxLike, root: string): Promise<void> {
  const r = await sb.exec('test -f pnpm-lock.yaml', { cwd: root });
  if (r.exitCode !== 0) throw new SourceBuildError(PNPM_LOCKFILE_REQUIRED);
}

/**
 * A sandbox write is one Workers RPC, and workerd refuses an RPC argument over 32 MiB
 * serialised. A submitted source tree may be larger (`SOURCE_BYTES_MAX`), so it is
 * written in parts and joined inside the container. 8 Mi chars stay under the limit
 * even as a two-byte string.
 */
export async function writeSandboxFile(sb: SandboxLike, path: string, content: string, chunk = 8 * 1024 * 1024): Promise<void> {
  if (content.length <= chunk) {
    await sb.writeFile(path, content);
    return;
  }
  const parts: string[] = [];
  for (let start = 0; start < content.length;) {
    let end = Math.min(start + chunk, content.length);
    // A part ending on a high surrogate would write each half of the pair as U+FFFD.
    if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1]!)) end--;
    const part = `${path}.part${parts.length}`;
    await sb.writeFile(part, content.slice(start, end));
    parts.push(shellQuote(part));
    start = end;
  }
  await checkedExec(sb, `cat ${parts.join(' ')} > ${shellQuote(path)} && rm -f ${parts.join(' ')}`);
}

export async function checkoutRepository(sb: SandboxLike, access: RepositoryAccess, root: string, branch: string): Promise<void> {
  await checkedExec(sb, `git check-ref-format --branch ${shellQuote(branch)}`);
  const probe = await sb.exec(`test -d ${shellQuote(`${root}/.git`)}`);
  if (probe.exitCode === 0) {
    const dirty = await checkedExec(sb, 'git status --porcelain', root);
    if (dirty) return; // preserve edits; the eventual push detects a concurrent writer
    // The branch may not exist yet: a studio turn commits locally and pushes only when it
    // changed files, so an interview turn leaves the remote empty. Fetching it would fail.
    const refs = await repositoryGit(sb, access, ['ls-remote', '--heads', access.remote, `refs/heads/${branch}`], root);
    if (!refs) return;
    const head = await sb.exec('git rev-parse --verify HEAD', { cwd: root });
    if (head.exitCode !== 0) {
      // Another writer initialized the branch since this empty clone was opened.
      await repositoryGit(sb, access, ['fetch', access.remote, `refs/heads/${branch}`], root);
      await checkedExec(sb, `git -c core.hooksPath=/dev/null checkout -B ${shellQuote(branch)} FETCH_HEAD`, root);
      return;
    }
    await repositoryGit(sb, access, ['fetch', access.remote, `refs/heads/${branch}`], root);
    await checkedExec(sb, 'git -c core.hooksPath=/dev/null merge --ff-only FETCH_HEAD', root);
    return;
  }
  await repositoryGit(sb, access, ['clone', '--no-checkout', access.remote, root]);
  // A new Artifacts repository has no branch yet. Only an empty repo may initialize one.
  const refs = await checkedExec(sb, 'git for-each-ref --format="%(refname)" refs/remotes', root);
  if (!refs) {
    await checkedExec(sb, `git checkout --orphan ${shellQuote(branch)}`, root);
  } else {
    await checkedExec(sb, `git -c core.hooksPath=/dev/null checkout -B ${shellQuote(branch)} ${shellQuote(`origin/${branch}`)}`, root);
  }
}

export async function saveRepository(sb: SandboxLike, access: RepositoryAccess, root: string, branch: string): Promise<string> {
  const revision = await checkedExec(sb, 'git rev-parse HEAD', root);
  // Ordinary push is compare-and-swap against the remote's history, never force-push.
  await repositoryGit(sb, access, ['push', access.remote, `HEAD:refs/heads/${branch}`], root);
  return revision;
}

/** The remote branch's commit, or null when the remote has no such branch. */
export async function remoteTip(sb: SandboxLike, access: RepositoryAccess, root: string, branch: string): Promise<string | null> {
  const line = await repositoryGit(sb, access, ['ls-remote', '--heads', access.remote, `refs/heads/${branch}`], root);
  return line.split(/\s/)[0] || null;
}

async function isAncestor(sb: SandboxLike, root: string, a: string, b: string): Promise<boolean> {
  return (await sb.exec(`git merge-base --is-ancestor ${shellQuote(a)} ${shellQuote(b)}`, { cwd: root })).exitCode === 0;
}

/**
 * Put the checkout at `root` on a chat's branch. A chat works on a branch of its own, never on
 * the project's base, so a turn cannot reach the branch a deploy reads. A branch not pushed yet
 * starts from the base's tip, or empty when the base has no commit either.
 *
 * On the branch already, this is `checkoutRepository`: edits are kept and a moved remote is
 * fast-forwarded. Switching from another chat's branch with edits in the tree hands them to
 * `park` first, and then discards them, so one chat's unfinished work never lands in another's.
 * A tree on a branch no chat owns (a project from before chats, on its base) carries its edits
 * over: the new branch starts at the same commit, so nothing conflicts. Returns the branch the
 * checkout was on (null when it was fresh or already on `branch`), and whether `branch` was
 * started here from the base: a chat with no commit of its own yet.
 */
export async function checkoutBranch(
  sb: SandboxLike,
  access: RepositoryAccess,
  root: string,
  branch: string,
  base: string,
  park?: (from: string) => Promise<void>,
): Promise<{ fresh: boolean; from: string | null; fromBase: boolean }> {
  for (const name of [branch, base]) await checkedExec(sb, `git check-ref-format --branch ${shellQuote(name)}`);
  const fresh = (await sb.exec(`test -d ${shellQuote(`${root}/.git`)}`)).exitCode !== 0;
  if (fresh) await repositoryGit(sb, access, ['clone', '--no-checkout', access.remote, root]);
  const current = fresh ? null : (await sb.exec('git symbolic-ref --short -q HEAD', { cwd: root })).stdout.trim() || null;
  if (current === branch) {
    await checkoutRepository(sb, access, root, branch);
    return { fresh: false, from: null, fromBase: false };
  }
  if (current && (await checkedExec(sb, 'git status --porcelain', root)) && current.startsWith(CHAT_BRANCH_PREFIX)) {
    await park?.(current);
    await checkedExec(sb, 'git -c core.hooksPath=/dev/null reset -q --hard && git clean -fdq', root);
  }
  const start = (await remoteTip(sb, access, root, branch)) ? branch : (await remoteTip(sb, access, root, base)) ? base : null;
  if (start) {
    await repositoryGit(sb, access, ['fetch', access.remote, `refs/heads/${start}`], root);
    await checkedExec(sb, `git -c core.hooksPath=/dev/null checkout -B ${shellQuote(branch)} FETCH_HEAD`, root);
  } else {
    await checkedExec(sb, `git checkout -q --orphan ${shellQuote(branch)}`, root);
    // An orphan keeps the old branch's files staged; an empty base starts empty.
    if (!fresh) await checkedExec(sb, 'git read-tree --empty && git clean -fdq', root);
  }
  return { fresh, from: current, fromBase: start !== branch };
}

/** Every chat branch starts with this; the base never does. */
export const CHAT_BRANCH_PREFIX = 'builder/';

export type MergeResult =
  | { ok: true; revision: string; how: 'fast-forward' | 'merge' | 'up-to-date' }
  | { ok: false; reason: 'uncommitted' | 'conflict' | 'gates'; detail: string };

/**
 * Bring the chat branch checked out at `root` into `base`. A chat that only adds to the base
 * moves it forward. One the base moved away from is merged with it here, on the chat's branch,
 * and the base moves only when `gates` passes the merged tree (it answers null, or the red
 * report): a conflict or a red gate leaves both branches where they were. Both pushes are the
 * ordinary compare-and-swap, so a base that moved meanwhile refuses rather than being
 * overwritten.
 */
export async function mergeIntoBase(
  sb: SandboxLike,
  access: RepositoryAccess,
  root: string,
  branch: string,
  base: string,
  gates: () => Promise<string | null>,
): Promise<MergeResult> {
  if (await checkedExec(sb, 'git status --porcelain', root)) {
    return { ok: false, reason: 'uncommitted', detail: 'this chat has uncommitted changes; let its turn finish first' };
  }
  const head = await checkedExec(sb, 'git rev-parse HEAD', root);
  if (!(await remoteTip(sb, access, root, base))) {
    await repositoryGit(sb, access, ['push', access.remote, `HEAD:refs/heads/${base}`], root);
    return { ok: true, revision: head, how: 'fast-forward' };
  }
  await repositoryGit(sb, access, ['fetch', access.remote, `refs/heads/${base}`], root);
  const tip = await checkedExec(sb, 'git rev-parse FETCH_HEAD', root);
  if (await isAncestor(sb, root, head, tip)) return { ok: true, revision: tip, how: 'up-to-date' };
  if (await isAncestor(sb, root, tip, head)) {
    await repositoryGit(sb, access, ['push', access.remote, `HEAD:refs/heads/${base}`], root);
    return { ok: true, revision: head, how: 'fast-forward' };
  }
  const merge = await sb.exec(
    `git -c core.hooksPath=/dev/null -c user.name=Substrat -c user.email=builder@substrat.invalid merge --no-ff --no-edit -m ${shellQuote(`Merge ${base} into ${branch}`)} FETCH_HEAD`,
    { cwd: root },
  );
  if (merge.exitCode !== 0) {
    const files = (await sb.exec('git diff --name-only --diff-filter=U', { cwd: root })).stdout.trim().split('\n').filter(Boolean);
    await checkedExec(sb, 'git merge --abort', root);
    return { ok: false, reason: 'conflict', detail: `${base} changed the same lines as this chat${files.length ? ` in ${files.join(', ')}` : ''}; ask the chat to bring in ${base} and resolve them` };
  }
  const red = await gates();
  if (red !== null) {
    await checkedExec(sb, `git -c core.hooksPath=/dev/null reset -q --hard ${shellQuote(head)}`, root);
    return { ok: false, reason: 'gates', detail: `merged with ${base}, the project fails its checks; nothing was merged:\n${red}` };
  }
  await repositoryGit(sb, access, ['push', access.remote, `HEAD:refs/heads/${branch}`], root);
  await repositoryGit(sb, access, ['push', access.remote, `HEAD:refs/heads/${base}`], root);
  return { ok: true, revision: await checkedExec(sb, 'git rev-parse HEAD', root), how: 'merge' };
}
