import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMainModule, repoRoot, toPosix } from './repo-path.mjs';

test('repoRoot is the checkout, where URL.pathname is not', () => {
  const broken = new URL('..', import.meta.url).pathname;
  const root = repoRoot(import.meta.url);
  assert.equal(existsSync(join(root, 'package.json')), true);
  // The pathname form is `/C:/...` on Windows and names no directory, so a gate
  // rooted on it scans nothing. On POSIX both spellings can exist.
  if (process.platform === 'win32') {
    assert.equal(existsSync(join(broken, 'package.json')), false);
  }
});

test('a child of the root is a posix path with no leading separator', () => {
  const root = 'C:\\repo';
  const child = 'C:\\repo\\demos\\todo\\PERMISSIONS.md';
  assert.equal(toPosix(win32.relative(root, child)), 'demos/todo/PERMISSIONS.md');
  assert.equal(child.slice(root.length).startsWith('\\'), true);
});

test('toPosix turns a Windows relative path into the spelling source uses', () => {
  assert.equal(toPosix('concepts\\tenancy.md'), 'concepts/tenancy.md');
  assert.equal(toPosix('concepts/tenancy.md'), 'concepts/tenancy.md');
  // permission-diff decides "this is a repo vertical" with a forward-slash regex.
  // A backslash relative path never matches, so the header would drift.
  assert.equal(/^(demos|apps)\/[^/]+$/.test('demos\\todo'), false);
  assert.equal(/^(demos|apps)\/[^/]+$/.test(toPosix('demos\\todo')), true);
});

test('isMainModule sees the script through a symlinked path, and not another file', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'is-main-')));
  try {
    writeFileSync(join(dir, 'tool.mjs'), '');
    writeFileSync(join(dir, 'other.mjs'), '');
    symlinkSync(dir, join(dir, 'linked'));
    const url = pathToFileURL(join(dir, 'tool.mjs')).href;
    assert.equal(isMainModule(url, join(dir, 'linked', 'tool.mjs')), true);
    assert.equal(isMainModule(url, join(dir, 'tool.mjs')), true);
    assert.equal(isMainModule(url, join(dir, 'other.mjs')), false);
    assert.equal(isMainModule(url, undefined), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
