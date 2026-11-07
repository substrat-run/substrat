import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { push } from '../src/push.js';
import { collectSourceSnapshot } from '../src/source-snapshot.js';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function project() {
  const dir = mkdtempSync(join(tmpdir(), 'source-snapshot-'));
  roots.push(dir);
  writeFileSync(join(dir, 'package.json'), '{"name":"acme"}');
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}
function workspace() {
  const dir = project();
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages: [apps/*, packages/*]\n');
  for (const pkg of ['apps/demo', 'packages/domain']) {
    mkdirSync(join(dir, pkg, 'test'), { recursive: true });
    mkdirSync(join(dir, pkg, 'src'), { recursive: true });
    writeFileSync(join(dir, pkg, 'test/a.test.ts'), '');
    writeFileSync(join(dir, pkg, 'src/index.ts'), '');
    writeFileSync(join(dir, pkg, 'CHANGELOG.md'), '');
  }
  writeFileSync(join(dir, 'apps/demo/package.json'), '{"name":"demo","dependencies":{"domain":"workspace:*"}}');
  writeFileSync(join(dir, 'packages/domain/package.json'), '{"name":"domain"}');
  return dir;
}

describe('source submission', () => {
  it('captures the working tree, untracked files, binary content and executable modes while excluding credentials and outputs', () => {
    const dir = project();
    writeFileSync(join(dir, 'app.ts'), 'old');
    writeFileSync(join(dir, 'deleted.ts'), 'deleted');
    execFileSync('git', ['-C', dir, 'add', '.']);
    writeFileSync(join(dir, 'app.ts'), 'uncommitted');
    rmSync(join(dir, 'deleted.ts'));
    writeFileSync(join(dir, 'image.bin'), new Uint8Array([0, 255, 10]));
    writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\n');
    chmodSync(join(dir, 'run.sh'), 0o755);
    execFileSync('git', ['-C', dir, 'add', 'run.sh']);
    execFileSync('git', ['-C', dir, 'update-index', '--chmod=+x', 'run.sh']);
    writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n');
    for (const name of ['.env', '.env.production', '.dev.vars', '.npmrc', 'ignored.txt']) writeFileSync(join(dir, name), 'secret');
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist/app.js'), 'built');
    const snapshot = collectSourceSnapshot(dir);
    const files = new Map(snapshot.files.map((f) => [f.path, f]));
    expect(Buffer.from(files.get('app.ts')!.base64, 'base64').toString()).toBe('uncommitted');
    expect([...Buffer.from(files.get('image.bin')!.base64, 'base64')]).toEqual([0, 255, 10]);
    expect(files.get('run.sh')!.executable).toBe(true);
    expect([...files.keys()].sort()).toEqual(['.gitignore', 'app.ts', 'image.bin', 'package.json', 'run.sh']);
  });

  it('includes the workspace around a monorepo app so local package dependencies can build, without their tests or changelogs', () => {
    const dir = workspace();
    const snapshot = collectSourceSnapshot(join(dir, 'apps/demo'));
    expect(snapshot.directory).toBe('apps/demo');
    expect(snapshot.files.map((f) => f.path).filter((p) => p.includes('/')).sort()).toEqual([
      'apps/demo/CHANGELOG.md', 'apps/demo/package.json', 'apps/demo/src/index.ts', 'apps/demo/test/a.test.ts',
      'packages/domain/package.json', 'packages/domain/src/index.ts',
    ]);
  });

  it('uploads a workspace member whose pnpm lockfile sits at the workspace root', async () => {
    const dir = workspace();
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    vi.stubGlobal('fetch', async () => Response.json({ id: 'v1', admission: 'admitted', deploymentRef: 'r', verticalSlug: 'demo' }));
    await expect(push({ dir: join(dir, 'apps/demo'), slug: 'demo', version: '1.0.0', controlPlaneUrl: 'https://cp.test', authHeader: {} })).resolves.toMatchObject({ id: 'v1' });
  });

  it.skipIf(process.platform === 'win32')('refuses a symlink instead of reading files outside the source tree', () => {
    const dir = project();
    symlinkSync('/etc/passwd', join(dir, 'outside'));
    expect(() => collectSourceSnapshot(dir)).toThrow(/symlink/);
  });
});
