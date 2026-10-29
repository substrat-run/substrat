import type { ProjectRepository } from '@substrat-run/contracts';
import type { SandboxLike } from '@substrat-run/builder-workspace/edge';
import { SourceBuildError } from './problem.js';

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
  if (r.exitCode !== 0) throw new SourceBuildError(`command failed: ${(r.stderr || r.stdout).slice(-6000)}`);
  return r.stdout.trim();
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
    const head = await sb.exec('git rev-parse --verify HEAD', { cwd: root });
    if (head.exitCode !== 0) {
      // Another writer may have initialized the branch since this empty clone was opened.
      const refs = await repositoryGit(sb, access, ['ls-remote', '--heads', access.remote, `refs/heads/${branch}`], root);
      if (!refs) return;
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
