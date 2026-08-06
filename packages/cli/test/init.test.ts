import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeCiWorkflow, detectDefaultBranch, DEFAULT_WORKFLOW_PATH } from '../src/init.js';

/**
 * `substrat init --ci github` — the CI recipe as a generated file (#509 open question 3).
 * The workflow BODY is generated in `@substrat-run/contracts` and asserted there and in the
 * dashboard's suite; what is this package's job is the file-system contract around it:
 * where it writes, what it refuses to clobber, and how the branch is guessed.
 */
describe('init --ci github', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-init-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const base = () => ({ dir, slug: 'helpdesk', branch: 'main', cpUrl: 'https://cp.example/api', force: false });

  it('writes the workflow at the conventional path, creating .github/workflows', () => {
    const { file, overwritten } = writeCiWorkflow({ ...base(), release: 'trunk' });
    expect(overwritten).toBe(false);
    expect(file).toBe(join(dir, DEFAULT_WORKFLOW_PATH));
    const yaml = readFileSync(file, 'utf8');
    expect(yaml).toContain('name: Deploy to Substrat');
    expect(yaml).toContain('branches: [main]');
    expect(yaml).toContain('--slug helpdesk');
    expect(yaml).toContain('SUBSTRAT_CP_URL: https://cp.example/api');
    // The recipe must be discoverable from the file itself — that is the whole point of
    // generating it rather than writing it up in a doc nobody opens.
    expect(yaml).toContain('https://substrat.net/guide/environments-and-previews');
  });

  it('refuses to clobber an existing workflow unless forced', () => {
    writeCiWorkflow({ ...base(), release: 'trunk' });
    const file = join(dir, DEFAULT_WORKFLOW_PATH);
    writeFileSync(file, '# hand-edited\n');

    // The generated file is meant to be edited afterwards (it is a normal workflow, not a
    // managed artifact), so silently overwriting a builder's edits is the worst default.
    expect(() => writeCiWorkflow({ ...base(), release: 'trunk' })).toThrow(/already exists/);
    expect(readFileSync(file, 'utf8')).toBe('# hand-edited\n');

    const forced = writeCiWorkflow({ ...base(), release: 'trunk', force: true });
    expect(forced.overwritten).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('name: Deploy to Substrat');
  });

  it('honours an explicit --out path', () => {
    const { file } = writeCiWorkflow({ ...base(), release: 'trunk', path: '.github/workflows/ship.yml' });
    expect(file).toBe(join(dir, '.github/workflows/ship.yml'));
    expect(readFileSync(file, 'utf8')).toContain('name: Deploy to Substrat');
  });

  it('reads the default branch from .git/HEAD, and falls back to main', () => {
    expect(detectDefaultBranch(dir)).toBe('main'); // no checkout at all
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/trunk\n');
    expect(detectDefaultBranch(dir)).toBe('trunk');
    // A branch name may contain slashes; the ref parse must keep the whole thing.
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/release/2026-08\n');
    expect(detectDefaultBranch(dir)).toBe('release/2026-08');
    // Detached HEAD is a sha, not a ref — guessing `main` beats writing a sha as a branch.
    writeFileSync(join(dir, '.git', 'HEAD'), '9c1f2a0e5b\n');
    expect(detectDefaultBranch(dir)).toBe('main');
  });
});
