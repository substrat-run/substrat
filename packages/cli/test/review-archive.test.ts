import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, expect, it } from 'vitest';
import { assertCleanReviewTree, reviewArchive } from '../src/review-archive.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('packs the committed tree as deterministic, PAX-free USTAR', () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-archive-'));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  writeFileSync(join(dir, 'main.ts'), 'export const one = 1;\n');
  git('add', 'main.ts');
  git('commit', '-qm', 'source');
  assertCleanReviewTree(dir);
  const first = reviewArchive(dir, 'HEAD');
  const second = reviewArchive(dir, 'HEAD');
  expect(first.sha256).toBe(second.sha256);
  expect(first.bytes).toEqual(second.bytes);
  const tar = gunzipSync(first.bytes);
  expect(tar.toString('utf8', 0, 7)).toBe('main.ts');
  expect(tar.toString('utf8', 257, 262)).toBe('ustar');
  expect(tar[156]).toBe(48);
  expect(tar.toString('utf8', 512, 512 + Buffer.byteLength('export const one = 1;\n'))).toBe('export const one = 1;\n');
  writeFileSync(join(dir, 'main.ts'), 'export const one = 2;\n');
  expect(() => assertCleanReviewTree(dir)).toThrow(/commit/);
});
