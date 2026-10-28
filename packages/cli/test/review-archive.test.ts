import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, expect, it } from 'vitest';
import { assertCleanReviewTree, reviewArchive } from '../src/review-archive.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('packs the committed tree as deterministic USTAR', () => {
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

it('round-trips the repository docs that need deterministic PAX path extensions', () => {
  const paths = [
    'docs/decisions/K-052-the-scope-store-envelope-is-ed25519-per-audience-and-an-object-is-bound-to-its-name-by-its-id.md',
    'docs/decisions/K-055-a-platform-host-s-standing-principal-holds-a-system-only-key-through-a-role-declared-holder-system.md',
    'docs/decisions/K-057-a-semantic-index-is-scope-local-a-semantic-read-is-declared-eventual-an-external-index-only-as-a-store-driver.md',
    'docs/decisions/K-058-a-call-from-the-platform-to-a-vertical-carries-an-ed25519-envelope-and-a-deployed-vertical-holds-public-keys-only.md',
  ];
  const dir = mkdtempSync(join(tmpdir(), 'review-pax-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'docs/decisions'), { recursive: true });
  for (const path of paths) writeFileSync(join(dir, path), readFileSync(new URL(`../../../${path}`, import.meta.url)));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  git('add', '.');
  git('commit', '-qm', 'source');
  const first = reviewArchive(dir, 'HEAD');
  const second = reviewArchive(dir, 'HEAD');
  expect(first.sha256).toBe(second.sha256);
  expect(first.bytes).toEqual(second.bytes);
  const tar = gunzipSync(first.bytes);
  let at = 0;
  for (const path of paths) {
    expect(tar[at + 156]).toBe(120);
    const paxSize = Number.parseInt(tar.toString('ascii', at + 124, at + 136).replace(/\0.*$/, '').trim(), 8);
    const record = tar.toString('utf8', at + 512, at + 512 + paxSize);
    expect(record).toBe(`${Buffer.byteLength(record)} path=${path}\n`);
    at += 512 + Math.ceil(paxSize / 512) * 512;
    expect(tar[at + 156]).toBe(48);
    const fileSize = Number.parseInt(tar.toString('ascii', at + 124, at + 136).replace(/\0.*$/, '').trim(), 8);
    // Git may normalize CRLF in a Windows checkout; the archive reads the committed blob.
    expect(tar.subarray(at + 512, at + 512 + fileSize)).toEqual(git('show', `HEAD:${path}`));
    at += 512 + Math.ceil(fileSize / 512) * 512;
  }
});

it('refuses a committed tree path with invalid UTF-8 bytes instead of renaming it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-invalid-utf8-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: 'content' }).toString().trim();
  const path = Buffer.from([98, 97, 100, 45, 255, 46, 116, 120, 116]);
  const row = Buffer.concat([Buffer.from(`100644 blob ${blob}\t`), path, Buffer.from([0])]);
  const tree = execFileSync('git', ['mktree', '-z'], { cwd: dir, input: row }).toString().trim();
  expect(() => reviewArchive(dir, tree)).toThrow(/invalid UTF-8.*6261642dff2e747874/);
});
