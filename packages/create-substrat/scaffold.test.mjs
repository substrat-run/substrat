import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('scaffold emits the pnpm build policy', () => {
  const parent = mkdtempSync(join(tmpdir(), 'create-substrat-'));
  const project = join(parent, 'project');
  try {
    execFileSync(process.execPath, [fileURLToPath(new URL('./index.js', import.meta.url)), project]);
    assert.equal(
      readFileSync(join(project, 'pnpm-workspace.yaml'), 'utf8').replace(/\r\n/g, '\n'),
      'allowBuilds:\n  esbuild: false\n  workerd: false\n',
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
