import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SandboxLike } from '@substrat-run/builder-workspace/edge';
import { checkoutRepository, repositoryAccess, saveRepository, type ArtifactRepositories } from '../src/repositories.js';

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
