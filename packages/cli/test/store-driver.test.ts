import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { STORE_RELEASE_MAX_BYTES, STORE_RELEASE_MAX_MODULES, storeDriverReleaseUpload } from '@substrat-run/contracts';
import { isReleaseSha, packedFilesOf, packStoreDriverDir, sourceCommitOf, storeDriverStatusLines } from '../src/store-driver.js';

const COMMIT = 'a'.repeat(40);

function driverDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'store-driver-pack-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

describe('packStoreDriverDir (#2300)', () => {
  it('packs the driver package recursively by relative path, skipping bytecode', () => {
    const dir = driverDir({
      'driver_graph/__init__.py': '',
      'driver_graph/store.py': 'class Store:\n    pass\n',
      'driver_graph/schema/v1.py': 'X = 1\n',
      'driver_graph/__pycache__/store.cpython-312.pyc': 'bytecode',
    });
    try {
      const body = packStoreDriverDir(dir, 'driver_graph/store.py', COMMIT);
      expect(body.modules.map((m) => m.name)).toEqual(['driver_graph/__init__.py', 'driver_graph/schema/v1.py', 'driver_graph/store.py']);
      expect(atob(body.modules[2]!.contentBase64)).toBe('class Store:\n    pass\n');
      // What the control plane parses.
      expect(storeDriverReleaseUpload.safeParse(body).success).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('packs python_modules beside the one driver package: a .py, a data file and a nested package', () => {
    const dir = driverDir({
      'driver_graph/store.py': 'class Store:\n    pass\n',
      'python_modules/six.py': 'def six():\n    return 6\n',
      'python_modules/vendor_probe/payload.txt': 'payload-ok',
      'python_modules/vendor_probe/nested/mod.py': 'N = 1\n',
      'python_modules/vendor_probe/__pycache__/mod.cpython-314.pyc': 'bytecode',
    });
    try {
      const body = packStoreDriverDir(dir, 'driver_graph/store.py', COMMIT);
      expect(body.modules.map((m) => m.name)).toEqual([
        'driver_graph/store.py',
        'python_modules/six.py',
        'python_modules/vendor_probe/nested/mod.py',
        'python_modules/vendor_probe/payload.txt',
      ]);
      expect(storeDriverReleaseUpload.safeParse(body).success).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a file outside the driver package and python_modules, a second package, and a missing entry', () => {
    const cases: [Record<string, string>, RegExp][] = [
      [{ 'driver_graph/store.py': '', 'driver_graph/data.json': '{}' }, /driver_graph\/data\.json/],
      [{ 'driver_graph/store.py': '', 'wrangler.toml': '' }, /wrangler\.toml/],
      [{ 'driver_graph/store.py': '', 'driver_other/x.py': '' }, /exactly one driver_ package/],
      [{ 'driver_graph/store.py': '', 'python_modules/driver_other/x.py': '' }, /driver_other/],
      [{ 'driver_graph/store.py': '', 'python_modules/substrat_store/x.py': '' }, /substrat_store/],
      [{ 'driver_graph/store.py': '', 'python_modules/workers/__init__.py': '' }, /workers/],
      [{ 'driver_graph/store.py': '', 'python_modules/workers.py': '' }, /workers\.py/],
      [{ 'driver_graph/store.py': '', 'python_modules/js/ffi.py': '' }, /js\/ffi\.py/],
      [{ 'driver_graph/store.py': '', 'python_modules/pyodide/ffi.py': '' }, /pyodide/],
      [{ 'driver_graph/store.py': '', 'python_modules/_workers_sdk_patch_loader.py': '' }, /_workers_sdk/],
      [{ 'driver_graph/store.py': '', 'python_modules/pkg/extra.pth': '' }, /\.pth/],
      [{ 'driver_graph/store.py': '', 'python_modules/pyvenv.cfg': '' }, /pyvenv\.cfg/],
      [{ 'driver_graph/store.py': '', 'python_modules/pkg/marker.synced': '' }, /\.synced/],
    ];
    for (const [files, refusal] of cases) {
      const dir = driverDir(files);
      try {
        expect(() => packStoreDriverDir(dir, 'driver_graph/store.py', COMMIT), JSON.stringify(files)).toThrow(refusal);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    const dir = driverDir({ 'driver_graph/store.py': '' });
    try {
      expect(() => packStoreDriverDir(dir, 'driver_graph/missing.py', COMMIT)).toThrow(/missing\.py/);
      expect(() => packStoreDriverDir(dir, 'python_modules/six.py', COMMIT)).toThrow(/no python_modules\/six\.py|not a driver module/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a release over the module count or the byte cap', () => {
    const many: Record<string, string> = { 'driver_graph/store.py': '' };
    for (let i = 0; i < STORE_RELEASE_MAX_MODULES; i++) many[`python_modules/m${i}.py`] = '';
    const counted = driverDir(many);
    try {
      expect(() => packStoreDriverDir(counted, 'driver_graph/store.py', COMMIT)).toThrow(new RegExp(`${STORE_RELEASE_MAX_MODULES + 1} modules`));
    } finally {
      rmSync(counted, { recursive: true, force: true });
    }
    const huge = driverDir({ 'driver_graph/store.py': 'x'.repeat(STORE_RELEASE_MAX_BYTES + 1) });
    try {
      expect(() => packStoreDriverDir(huge, 'driver_graph/store.py', COMMIT)).toThrow(new RegExp(`${STORE_RELEASE_MAX_BYTES}`));
    } finally {
      rmSync(huge, { recursive: true, force: true });
    }
  });
});

describe('the files a release packs, and the commit they are (#2300)', () => {
  it('refuses a symbolic link, to a file or a directory loop, and a tree nested too deep', () => {
    const dir = driverDir({ 'driver_graph/store.py': '' });
    try {
      symlinkSync('/etc/hosts', join(dir, 'driver_graph/hosts.py'));
      expect(() => packedFilesOf(dir)).toThrow(/hosts\.py' is a symbolic link/);
      rmSync(join(dir, 'driver_graph/hosts.py'));
      symlinkSync(join(dir, 'driver_graph'), join(dir, 'driver_graph/loop'));
      expect(() => packedFilesOf(dir)).toThrow(/loop' is a symbolic link/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const deep = driverDir({ [`driver_graph/${'d/'.repeat(20)}x.py`]: '' });
    try {
      expect(() => packedFilesOf(deep)).toThrow(/nested more than 16/);
    } finally {
      rmSync(deep, { recursive: true, force: true });
    }
  });

  it('names the commit only when every packed file is committed there, unchanged', () => {
    const dir = driverDir({ 'driver_graph/store.py': 'class Store:\n    pass\n', '.gitignore': 'driver_graph/secret.py\n' });
    const git = (...args: string[]) => {
      const run = spawnSync('git', ['-C', dir, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], { encoding: 'utf8' });
      if (run.status !== 0) throw new Error(run.stderr);
      return run.stdout.trim();
    };
    try {
      git('init', '-q');
      git('add', '.');
      git('commit', '-qm', 'driver');
      const head = git('rev-parse', 'HEAD');
      const driverOnly = (files: string[]) => files.filter((f) => f.startsWith('driver_'));
      expect(sourceCommitOf(dir, driverOnly(packedFilesOf(dir)))).toBe(head);
      // An edit to a committed module.
      writeFileSync(join(dir, 'driver_graph/store.py'), 'class Store:\n    v = 2\n');
      expect(() => sourceCommitOf(dir, driverOnly(packedFilesOf(dir)))).toThrow(/uncommitted changes/);
      git('checkout', '--', 'driver_graph/store.py');
      // A module git ignores is packed but is not the commit.
      writeFileSync(join(dir, 'driver_graph/secret.py'), 'X = 1\n');
      expect(() => sourceCommitOf(dir, driverOnly(packedFilesOf(dir)))).toThrow(/driver_graph\/secret\.py is not committed/);
      rmSync(join(dir, 'driver_graph/secret.py'));
      // An untracked one, likewise.
      writeFileSync(join(dir, 'driver_graph/new.py'), 'Y = 1\n');
      expect(() => sourceCommitOf(dir, driverOnly(packedFilesOf(dir)))).toThrow(/new\.py is not committed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('store-driver rollout and status, before and after a request (#2300)', () => {
  it('says when a rollback stopped part way', () => {
    const lines = storeDriverStatusLines('graph', {
      driver: 'graph', pins: [], current: { sha256: 'b'.repeat(64), seq: 2, previousGoodSha256: 'a'.repeat(64) },
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
      driver: 'graph',
      pins: [],
      current: { sha256: 'b'.repeat(64), seq: 3, previousGoodSha256: 'a'.repeat(64) },
      rollouts: [],
      // After a diverged rollout the server rolls back onto the current release.
      rollbackTarget: 'b'.repeat(64),
      unfinishedRollback: null,
    });
    expect(lines[0]).toBe(`graph: current ${'b'.repeat(64)}, rolls back to ${'b'.repeat(64)}`);
    expect(storeDriverStatusLines('graph', { driver: 'graph', pins: [], current: null, rollouts: [], rollbackTarget: null, unfinishedRollback: null })[0]).toBe('graph: current none, rolls back to nothing');
  });

  it('says whether every script carries what the control plane builds from now, which may not, and when it is walked again (#2309)', () => {
    const base = { driver: 'graph', pins: [], current: null, rollouts: [], rollbackTarget: null, unfinishedRollback: null };
    const fp = 'f'.repeat(64);
    const walk = { fingerprint: fp, fingerprintSince: '2026-10-16T00:00:00.000Z', attestedBy: null, verifiedAt: null, cursor: 'va', failures: [{ vertical: 'vb', detail: 'upload failed (500)' }], state: 'running' as const, startedAt: 't', updatedAt: 't', finishedAt: null };
    const behind = storeDriverStatusLines('graph', { ...base, rebuild: { fingerprint: fp, current: false, pending: ['vb', 'vc'], walk } });
    expect(behind.slice(1)).toEqual([
      `  scripts: NOT current: 2 may still be built from older keys or code (target ${'f'.repeat(12)})`,
      '    pending: vb, vc',
      '    failed: vb: upload failed (500)',
      '    first walked towards 2026-10-16T00:00:00.000Z',
    ]);
    const done = { ...walk, failures: [], state: 'done' as const, finishedAt: '2026-10-16T01:10:00.000Z' };
    const current = storeDriverStatusLines('graph', { ...base, rebuild: { fingerprint: fp, current: true, pending: [], nextWalk: '2026-10-17T01:10:00.000Z', walk: done } });
    expect(current.slice(1)).toEqual([
      `  scripts: current (every script is built from ${'f'.repeat(12)}, walk finished 2026-10-16T01:10:00.000Z)`,
      '    first walked towards 2026-10-16T00:00:00.000Z; next automatic re-walk 2026-10-17T01:10:00.000Z',
    ]);
    // Done, but too soon after the new lists appeared to prove it: settling, with why and when it is walked again.
    const early = { ...done, finishedAt: '2026-10-16T00:10:00.000Z' };
    const settling = storeDriverStatusLines('graph', { ...base, rebuild: { fingerprint: fp, current: false, pending: [], settling: '2026-10-16T01:00:00.000Z', nextWalk: '2026-10-16T01:00:00.000Z', walk: early } });
    expect(settling[1]).toMatch(/^ {2}scripts: settling: every script was current when walked \(2026-10-16T00:10:00\.000Z\)/);
    expect(settling[2]).toContain('walked again from 2026-10-16T01:00:00.000Z');
    expect(settling[3]).toBe('    `substrat store-driver rebuild --driver <driver> --deploy-finished` walks it at once and attests that.');
    expect(settling[4]).toBe('    first walked towards 2026-10-16T00:00:00.000Z; next automatic re-walk 2026-10-16T01:00:00.000Z');
    // A re-walk of a fleet already proved current reads as current, re-verifying.
    const rewalk = { ...walk, failures: [], startedAt: '2026-10-17T01:10:00.000Z', verifiedAt: '2026-10-16T01:10:00.000Z' };
    expect(storeDriverStatusLines('graph', { ...base, rebuild: { fingerprint: fp, current: true, reverifying: true, pending: [], walk: rewalk } })[1]).toBe(
      '  scripts: current (re-verifying: a walk since 2026-10-17T01:10:00.000Z re-checks every script; last proved 2026-10-16T01:10:00.000Z)',
    );
    // An attested walk says who attested.
    expect(storeDriverStatusLines('graph', { ...base, rebuild: { fingerprint: fp, current: true, pending: [], walk: { ...done, attestedBy: 'staff-1' } } })[1]).toContain(', deploy attested finished by staff-1');
    // A walk towards older lists says nothing about these lists' timing.
    expect(storeDriverStatusLines('graph', { ...base, rebuild: { fingerprint: fp, current: false, pending: ['va'], walk: { ...walk, failures: [], fingerprint: 'e'.repeat(64) } } }).at(-1)).toBe('    pending: va');
    // A control plane that does not rebuild says nothing about it.
    expect(storeDriverStatusLines('graph', base)).toHaveLength(1);
  });

});

// K-53's rename: the old command and flag name the new spelling and stop, before any auth or call.
describe('the pre-rename spelling, at the command line', () => {
  const cliJs = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cliJs, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });

  it('`substrat store-kind` exits naming `substrat store-driver` and --driver', () => {
    const r = run('store-kind', 'status', '--kind', 'graph');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('`substrat store-kind` was renamed `substrat store-driver`, and its --kind flag --driver');
  });

  it('`--kind` on `substrat store-driver` exits naming --driver', () => {
    const r = run('store-driver', 'status', '--kind', 'graph');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--kind was renamed --driver');
  });

  it('twin: `--driver` gets past both guards to the next check', () => {
    const r = run('store-driver', 'rollout', '--driver', 'graph');
    expect(r.status).toBe(1);
    expect(r.stderr).not.toMatch(/was renamed/);
    expect(r.stderr).toContain('a rollout names the release by --sha256');
  });
});
