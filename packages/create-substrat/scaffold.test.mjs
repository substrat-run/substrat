import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PACKAGE_MANAGER } from './project-files.js';

test('scaffold emits the pnpm build policy, and pins the pnpm it holds for', () => {
  const parent = mkdtempSync(join(tmpdir(), 'create-substrat-'));
  const project = join(parent, 'project');
  try {
    execFileSync(process.execPath, [fileURLToPath(new URL('./index.js', import.meta.url)), project]);
    assert.equal(
      readFileSync(join(project, 'pnpm-workspace.yaml'), 'utf8').replace(/\r\n/g, '\n'),
      'allowBuilds:\n  esbuild: false\n  workerd: false\n',
    );
    assert.equal(JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')).packageManager, PACKAGE_MANAGER);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
