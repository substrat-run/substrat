import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SandboxLike } from '@substrat-run/builder-workspace/edge';
import { PNPM_LOCKFILE_REQUIRED } from '@substrat-run/contracts';
import { SourceBuildError } from '../src/problem.js';
import { assertPnpmLockfile, checkoutBranch, checkoutRepository, mergeIntoBase, repositoryAccess, saveRepository, writeSandboxFile, type ArtifactRepositories } from '../src/repositories.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sandbox: SandboxLike = {
  async exec(command, options) {
    try { return { stdout: execFileSync('/bin/sh', ['-c', command], { cwd: options?.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '', exitCode: 0 }; }
    catch (error) { const e = error as { stdout?: string; stderr?: string; status?: number }; return { stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? ''), exitCode: e.status ?? 1 }; }
  },
  async readFile(path) { return readFileSync(path, 'utf8'); },
  async writeFile(path, content) { writeFileSync(path, content); },
  async mkdir(path) { mkdirSync(path, { recursive: true }); },
  async listFiles() { return []; },
  async exposePort() { return { url: '' }; },
};
const commit = (root: string, name: string, contents: string) => {
  writeFileSync(join(root, name), contents);
  execFileSync('git', ['-C', root, 'add', name]);
  execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Update source']);
};

describe('project repositories', () => {
  it('reopens saved source, refreshes a clean checkout, and refuses to overwrite a concurrent writer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'project-repository-'));
    roots.push(root);
    const remote = join(root, 'remote.git');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', '-q', remote]);
    const access = { remote, authorization: 'Bearer fixture-token' };
    const a = join(root, 'a'), b = join(root, 'b');
    await checkoutRepository(sandbox, access, a, 'main');
    // The studio can open an empty repo before the CLI publishes its first snapshot.
    await checkoutRepository(sandbox, access, b, 'main');
    commit(a, 'app.ts', 'first');
    const first = await saveRepository(sandbox, access, a, 'main');
    await checkoutRepository(sandbox, access, b, 'main');
    expect(readFileSync(join(b, 'app.ts'), 'utf8')).toBe('first');
    commit(a, 'app.ts', 'second');
    const second = await saveRepository(sandbox, access, a, 'main');
    expect(second).not.toBe(first);
    await checkoutRepository(sandbox, access, b, 'main');
    expect(readFileSync(join(b, 'app.ts'), 'utf8')).toBe('second');
    commit(a, 'app.ts', 'writer-a');
    await saveRepository(sandbox, access, a, 'main');
    commit(b, 'app.ts', 'writer-b');
    await expect(saveRepository(sandbox, access, b, 'main')).rejects.toThrow(/repository operation failed/);
    expect(readFileSync(join(b, 'app.ts'), 'utf8')).toBe('writer-b');
    expect(readFileSync(join(a, '.git/config'), 'utf8')).not.toContain('fixture-token');
    expect(execFileSync('git', ['--git-dir', remote, 'show', 'main:app.ts'], { encoding: 'utf8' })).toBe('writer-a');
  });

  it('reopens a checkout whose local commit was never pushed to the still-empty repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'project-repository-'));
    roots.push(root);
    const remote = join(root, 'remote.git');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', '-q', remote]);
    const access = { remote, authorization: 'Bearer fixture-token' };
    const a = join(root, 'a');
    await checkoutRepository(sandbox, access, a, 'main');
    // A studio turn commits locally and pushes only when it changed files.
    execFileSync('git', ['-C', a, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-q', '--allow-empty', '-m', 'Project created']);
    const head = execFileSync('git', ['-C', a, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    await checkoutRepository(sandbox, access, a, 'main');
    expect(execFileSync('git', ['-C', a, 'rev-parse', 'HEAD'], { encoding: 'utf8' })).toBe(head);
  });

  // Over the 1 s budget: each case is a dozen real git processes against a bare remote, and
  // the merge case is two to three seconds locally. That is the oracle — a fake git would
  // agree with whatever the code assumed about it.
  describe('chat branches', { timeout: 10_000 }, () => {
    const show = (remote: string, ref: string) => execFileSync('git', ['--git-dir', remote, 'show', ref], { encoding: 'utf8' });
    const world = async () => {
      const root = mkdtempSync(join(tmpdir(), 'chat-branches-'));
      roots.push(root);
      const remote = join(root, 'remote.git');
      execFileSync('git', ['init', '--bare', '--initial-branch=main', '-q', remote]);
      const access = { remote, authorization: 'Bearer fixture-token' };
      const work = join(root, 'work');
      await checkoutRepository(sandbox, access, work, 'main');
      commit(work, 'app.ts', 'base');
      await saveRepository(sandbox, access, work, 'main');
      return { root, remote, access, work };
    };

    it('starts a chat from the base, keeps its commits off the base, and parks unfinished work on a switch', async () => {
      const { remote, access, work } = await world();
      expect(await checkoutBranch(sandbox, access, work, 'builder/a', 'main')).toEqual({ fresh: false, from: 'main', fromBase: true });
      commit(work, 'app.ts', 'chat a');
      await saveRepository(sandbox, access, work, 'builder/a');
      writeFileSync(join(work, 'app.ts'), 'a, unfinished');
      const parked: string[] = [];
      await checkoutBranch(sandbox, access, work, 'builder/b', 'main', async (from) => { parked.push(from); });
      // The base and the new chat see neither a's commit nor its unfinished edit.
      expect(parked).toEqual(['builder/a']);
      expect(readFileSync(join(work, 'app.ts'), 'utf8')).toBe('base');
      expect(show(remote, 'main:app.ts')).toBe('base');
      expect(await checkoutBranch(sandbox, access, work, 'builder/a', 'main')).toMatchObject({ from: 'builder/b', fromBase: false });
      expect(readFileSync(join(work, 'app.ts'), 'utf8')).toBe('chat a');
    });

    it('fast-forwards the base, and merges a moved base only through green gates and no conflict', async () => {
      const { remote, access, work } = await world();
      await checkoutBranch(sandbox, access, work, 'builder/a', 'main');
      commit(work, 'a.ts', 'a');
      await saveRepository(sandbox, access, work, 'builder/a');
      const green = async () => null;
      expect(await mergeIntoBase(sandbox, access, work, 'builder/a', 'main', green)).toMatchObject({ ok: true, how: 'fast-forward' });
      expect(show(remote, 'main:a.ts')).toBe('a');

      // b starts before c moves the base, so b's merge is a real one.
      await checkoutBranch(sandbox, access, work, 'builder/b', 'main');
      commit(work, 'app.ts', 'b');
      await saveRepository(sandbox, access, work, 'builder/b');
      await checkoutBranch(sandbox, access, work, 'builder/c', 'main');
      commit(work, 'c.ts', 'c');
      await saveRepository(sandbox, access, work, 'builder/c');
      await mergeIntoBase(sandbox, access, work, 'builder/c', 'main', green);
      await checkoutBranch(sandbox, access, work, 'builder/b', 'main');
      const before = execFileSync('git', ['--git-dir', remote, 'rev-parse', 'main'], { encoding: 'utf8' });
      expect(await mergeIntoBase(sandbox, access, work, 'builder/b', 'main', async () => 'typecheck: red')).toMatchObject({ ok: false, reason: 'gates' });
      expect(execFileSync('git', ['--git-dir', remote, 'rev-parse', 'main'], { encoding: 'utf8' })).toBe(before);
      expect(readFileSync(join(work, 'app.ts'), 'utf8')).toBe('b');
      expect(await mergeIntoBase(sandbox, access, work, 'builder/b', 'main', green)).toMatchObject({ ok: true, how: 'merge' });
      expect([show(remote, 'main:app.ts'), show(remote, 'main:c.ts')]).toEqual(['b', 'c']);
      expect(show(remote, 'builder/b:c.ts')).toBe('c');
    });

    it('refuses a conflicting merge with the files named, leaving the chat as it was', async () => {
      const { remote, access, work } = await world();
      await checkoutBranch(sandbox, access, work, 'builder/a', 'main');
      commit(work, 'app.ts', 'a');
      await saveRepository(sandbox, access, work, 'builder/a');
      await checkoutBranch(sandbox, access, work, 'builder/b', 'main');
      commit(work, 'app.ts', 'b');
      await saveRepository(sandbox, access, work, 'builder/b');
      await mergeIntoBase(sandbox, access, work, 'builder/b', 'main', async () => null);
      await checkoutBranch(sandbox, access, work, 'builder/a', 'main');
      const refused = await mergeIntoBase(sandbox, access, work, 'builder/a', 'main', async () => null);
      expect(refused).toMatchObject({ ok: false, reason: 'conflict', detail: expect.stringContaining('app.ts') });
      expect(readFileSync(join(work, 'app.ts'), 'utf8')).toBe('a');
      expect(execFileSync('git', ['-C', work, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
      expect(show(remote, 'main:app.ts')).toBe('b');
    });
  });

  it('writes a file larger than one sandbox call in parts, never splitting a surrogate pair', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sandbox-write-'));
    roots.push(root);
    const writes: number[] = [];
    const recording: SandboxLike = { ...sandbox, async writeFile(path, content) { writes.push(content.length); writeFileSync(path, content); } };
    const content = 'abc😀defgh{"x":1}';
    await writeSandboxFile(recording, join(root, 'snapshot.json'), content, 4);
    expect(readFileSync(join(root, 'snapshot.json'), 'utf8')).toBe(content);
    expect(Math.max(...writes)).toBeLessThanOrEqual(4);
    expect(execFileSync('ls', [root], { encoding: 'utf8' }).trim()).toBe('snapshot.json');
  });

  it('refuses a tree with no pnpm lockfile as a reviewed build failure, and passes one that has it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'build-source-'));
    roots.push(root);
    writeFileSync(join(root, 'package-lock.json'), '');
    const refused = await assertPnpmLockfile(sandbox, root).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(SourceBuildError);
    expect((refused as Error).message).toBe(PNPM_LOCKFILE_REQUIRED);
    writeFileSync(join(root, 'pnpm-lock.yaml'), '');
    await expect(assertPnpmLockfile(sandbox, root)).resolves.toBeUndefined();
  });

  it('requests a short-lived repo-scoped token and releases the Artifacts capability', async () => {
    const calls: unknown[] = [];
    const handle = {
      async info() { return { remote: 'https://account.artifacts.cloudflare.net/git/projects/demo.git' }; },
      async createToken(scope: string, ttl: number) { calls.push([scope, ttl]); return { plaintext: 'short-token' }; },
      [Symbol.dispose]() { calls.push('disposed'); },
    };
    const artifacts = { async get() { return handle; } } as unknown as ArtifactRepositories;
    const access = await repositoryAccess(artifacts, { kind: 'artifacts', name: 'demo', remote: 'https://unused.test', branch: 'main' }, 'read', async () => { throw new Error('unexpected GitHub call'); });
    expect(access.authorization).toBe('Bearer short-token');
    expect(calls).toEqual([['read', 600], 'disposed']);
  });
});
