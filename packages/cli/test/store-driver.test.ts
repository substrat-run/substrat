import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { storeDriverReleaseUpload } from '@substrat-run/contracts';
import { isReleaseSha, packedFilesOf, packStoreDriverDir, sourceCommitOf, storeDriverStatusLines } from '../src/store-driver.js';

const COMMIT = 'a'.repeat(40);

function kindDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'store-driver-pack-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

describe('packStoreDriverDir (#2300)', () => {
  it('packs the kind package recursively by relative path, skipping bytecode', () => {
    const dir = kindDir({
      'kind_graph/__init__.py': '',
      'kind_graph/store.py': 'class Store:\n    pass\n',
      'kind_graph/schema/v1.py': 'X = 1\n',
      'kind_graph/__pycache__/store.cpython-312.pyc': 'bytecode',
    });
    try {
      const body = packStoreDriverDir(dir, 'kind_graph/store.py', COMMIT);
      expect(body.modules.map((m) => m.name)).toEqual(['kind_graph/__init__.py', 'kind_graph/schema/v1.py', 'kind_graph/store.py']);
      expect(atob(body.modules[2]!.contentBase64)).toBe('class Store:\n    pass\n');
      // What the control plane parses.
      expect(storeDriverReleaseUpload.safeParse(body).success).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a vendored package or any other file by name, a second package, and a missing entry', () => {
    const cases: [Record<string, string>, RegExp][] = [
      [{ 'kind_graph/store.py': '', 'python_modules/six.py': '' }, /refused: python_modules\/six\.py.*Vendored/],
      [{ 'kind_graph/store.py': '', 'kind_graph/data.json': '{}' }, /refused: kind_graph\/data\.json/],
      [{ 'kind_graph/store.py': '', 'wrangler.toml': '' }, /refused: wrangler\.toml/],
      [{ 'kind_graph/store.py': '', 'kind_other/x.py': '' }, /exactly one kind_ package/],
    ];
    for (const [files, refusal] of cases) {
      const dir = kindDir(files);
      try {
        expect(() => packStoreDriverDir(dir, 'kind_graph/store.py', COMMIT), JSON.stringify(files)).toThrow(refusal);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    const dir = kindDir({ 'kind_graph/store.py': '' });
    try {
      expect(() => packStoreDriverDir(dir, 'kind_graph/missing.py', COMMIT)).toThrow(/missing\.py/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the files a release packs, and the commit they are (#2300)', () => {
  it('refuses a symbolic link, to a file or a directory loop, and a tree nested too deep', () => {
    const dir = kindDir({ 'kind_graph/store.py': '' });
    try {
      symlinkSync('/etc/hosts', join(dir, 'kind_graph/hosts.py'));
      expect(() => packedFilesOf(dir)).toThrow(/hosts\.py' is a symbolic link/);
      rmSync(join(dir, 'kind_graph/hosts.py'));
      symlinkSync(join(dir, 'kind_graph'), join(dir, 'kind_graph/loop'));
      expect(() => packedFilesOf(dir)).toThrow(/loop' is a symbolic link/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const deep = kindDir({ [`kind_graph/${'d/'.repeat(20)}x.py`]: '' });
    try {
      expect(() => packedFilesOf(deep)).toThrow(/nested more than 16/);
    } finally {
      rmSync(deep, { recursive: true, force: true });
    }
  });

  it('names the commit only when every packed file is committed there, unchanged', () => {
    const dir = kindDir({ 'kind_graph/store.py': 'class Store:\n    pass\n', '.gitignore': 'kind_graph/secret.py\n' });
    const git = (...args: string[]) => {
      const run = spawnSync('git', ['-C', dir, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], { encoding: 'utf8' });
      if (run.status !== 0) throw new Error(run.stderr);
      return run.stdout.trim();
    };
    try {
      git('init', '-q');
      git('add', '.');
      git('commit', '-qm', 'kind');
      const head = git('rev-parse', 'HEAD');
      const kindOnly = (files: string[]) => files.filter((f) => f.startsWith('kind_'));
      expect(sourceCommitOf(dir, kindOnly(packedFilesOf(dir)))).toBe(head);
      // An edit to a committed module.
      writeFileSync(join(dir, 'kind_graph/store.py'), 'class Store:\n    v = 2\n');
      expect(() => sourceCommitOf(dir, kindOnly(packedFilesOf(dir)))).toThrow(/uncommitted changes/);
      git('checkout', '--', 'kind_graph/store.py');
      // A module git ignores is packed but is not the commit.
      writeFileSync(join(dir, 'kind_graph/secret.py'), 'X = 1\n');
      expect(() => sourceCommitOf(dir, kindOnly(packedFilesOf(dir)))).toThrow(/kind_graph\/secret\.py is not committed/);
      rmSync(join(dir, 'kind_graph/secret.py'));
      // An untracked one, likewise.
      writeFileSync(join(dir, 'kind_graph/new.py'), 'Y = 1\n');
      expect(() => sourceCommitOf(dir, kindOnly(packedFilesOf(dir)))).toThrow(/new\.py is not committed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('store-driver rollout and status, before and after a request (#2300)', () => {
  it('says when a rollback stopped part way', () => {
    const lines = storeDriverStatusLines('graph', {
      kind: 'graph', pins: [], current: { sha256: 'b'.repeat(64), seq: 2, previousGoodSha256: 'a'.repeat(64) },
      rollouts: [], rollbackTarget: 'a'.repeat(64), unfinishedRollback: 'a'.repeat(64),
    });
    expect(lines[1]).toBe(`  a rollback to ${'a'.repeat(64)} stopped part way: run \`substrat store-driver rollback\` again to finish it`);
  });

  it('names a release by its sha256 only', () => {
    expect(isReleaseSha('a'.repeat(64))).toBe(true);
    for (const bad of [undefined, '', 'A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(63)}g`]) expect(isReleaseSha(bad), String(bad)).toBe(false);
  });

  it("prints the server's rollback target, not the current release's previous good one", () => {
    const lines = storeDriverStatusLines('graph', {
      kind: 'graph',
      pins: [],
      current: { sha256: 'b'.repeat(64), seq: 3, previousGoodSha256: 'a'.repeat(64) },
      rollouts: [],
      // After a diverged rollout the server rolls back onto the current release.
      rollbackTarget: 'b'.repeat(64),
      unfinishedRollback: null,
    });
    expect(lines[0]).toBe(`graph: current ${'b'.repeat(64)}, rolls back to ${'b'.repeat(64)}`);
    expect(storeDriverStatusLines('graph', { kind: 'graph', pins: [], current: null, rollouts: [], rollbackTarget: null, unfinishedRollback: null })[0]).toBe('graph: current none, rolls back to nothing');
  });
});
