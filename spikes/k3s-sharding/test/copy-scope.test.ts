/**
 * `copyScope` never destroys a copy (#1638, review of #2202 round 2, finding 1).
 *
 * The shard once reached `copyScope(dir, dir)` for a scope whose own copy was incomplete,
 * and the copy began by deleting its destination, which was its source. It now refuses any
 * source and destination that are, or contain, one another, and it deletes nothing: the
 * copy it replaces is moved aside.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { copyScope } from '../src/todo-scope.js';

let root: string;
afterEach(() => rmSync(root, { recursive: true, force: true }));

function scopeAt(dir: string, text: string): void {
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, 'scope.sqlite'));
  db.exec('CREATE TABLE t (text TEXT)');
  db.prepare('INSERT INTO t VALUES (?)').run(text);
  db.close();
  writeFileSync(join(dir, 'world.json'), '{}');
}

const textIn = (dir: string) => {
  const db = new Database(join(dir, 'scope.sqlite'), { readonly: true });
  try {
    return db.prepare<[], { text: string }>('SELECT text FROM t').all().map((r) => r.text);
  } finally {
    db.close();
  }
};

describe('copyScope', () => {
  it('refuses to copy a scope onto itself, and leaves it whole', async () => {
    root = mkdtempSync(join(tmpdir(), 'k3s-copy-'));
    const dir = join(root, 'a', 'scopes', 's');
    scopeAt(dir, 'only copy');
    await expect(copyScope(dir, dir)).rejects.toThrow(/onto itself/);
    expect(readdirSync(dir).sort()).toEqual(['scope.sqlite', 'world.json']);
    expect(textIn(dir)).toEqual(['only copy']);
  });

  it('refuses a destination reached through a symlink, or nested in the source', async () => {
    root = mkdtempSync(join(tmpdir(), 'k3s-copy-'));
    const dir = join(root, 'a', 'scopes', 's');
    scopeAt(dir, 'only copy');
    const alias = join(root, 'alias');
    symlinkSync(dir, alias);
    await expect(copyScope(dir, alias)).rejects.toThrow(/onto itself/);
    await expect(copyScope(dir, join(dir, 'inner'))).rejects.toThrow(/onto itself/);
    expect(textIn(dir)).toEqual(['only copy']);
  });

  it('moves the copy it replaces aside rather than deleting it', async () => {
    root = mkdtempSync(join(tmpdir(), 'k3s-copy-'));
    const from = join(root, 'a', 'scopes', 's');
    const to = join(root, 'b', 'scopes', 's');
    scopeAt(from, 'latest');
    scopeAt(to, 'stale');
    await copyScope(from, to);
    expect(textIn(to)).toEqual(['latest']);
    const aside = readdirSync(join(root, 'b', 'scopes')).filter((n) => n.startsWith('s.superseded-'));
    expect(aside).toHaveLength(1);
    expect(textIn(join(root, 'b', 'scopes', aside[0]!))).toEqual(['stale']);
    expect(existsSync(from)).toBe(true);
  });
});
