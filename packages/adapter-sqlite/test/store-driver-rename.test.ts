/**
 * K-53's rename on a directory built before it, on the pure host: the release tables were
 * `store_kind_*`, and they and `vertical_scope_stores` keyed by `kind`. The DDL is all
 * `IF NOT EXISTS`, so a host that only ran it would read empty tables beside the old ones.
 * Staged as a deploy is: this code builds the directory, the old names are put back with rows
 * in them, and the next host over the same file is this code again.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { platformActorId } from '@substrat-run/contracts';
import { SqliteScopeHost } from '../src/index.js';

const staff = platformActorId.parse('01JZ00000000000000000000ST');
const SHA = 'a'.repeat(64);
const DRIVER_TABLES = ['store_driver_current', 'store_driver_holds', 'store_driver_releases', 'store_driver_rollouts'];

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A directory file as the code before the rename left it, holding a release, a current pointer and a binding. */
async function legacyDirectory(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-store-driver-rename-'));
  dirs.push(dir);
  await new SqliteScopeHost({ dir }).close();
  const db = new Database(join(dir, '_directory.sqlite'));
  try {
    for (const table of DRIVER_TABLES) {
      const old = table.replace('store_driver_', 'store_kind_');
      db.exec(`ALTER TABLE ${table} RENAME TO ${old}`);
      db.exec(`ALTER TABLE ${old} RENAME COLUMN driver TO kind`);
    }
    db.exec('ALTER TABLE vertical_scope_stores RENAME COLUMN driver TO kind');
    db.prepare(
      'INSERT INTO store_kind_releases (kind, sha256, source_commit, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?)',
    ).run('graph', SHA, 'b'.repeat(40), staff, '2026-10-15T00:00:00.000Z');
    db.prepare('INSERT INTO store_kind_current (kind, sha256, seq) VALUES (?, ?, ?)').run('graph', SHA, 1);
    db.prepare('INSERT INTO vertical_scope_stores (vertical_slug, binding, kind, first_version_id) VALUES (?, ?, ?, ?)').run(
      'docs', 'GRAPH', 'graph', '01JZ0000000000000000000V01',
    );
  } finally {
    db.close();
  }
  return dir;
}

describe('a directory built before the store driver rename (K-53)', () => {
  it('is staged for real: the old names hold the rows, and the new ones do not exist', async () => {
    const dir = await legacyDirectory();
    const db = new Database(join(dir, '_directory.sqlite'), { readonly: true });
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    const bindingColumns = (db.prepare('PRAGMA table_info(vertical_scope_stores)').all() as { name: string }[]).map((c) => c.name);
    db.close();
    expect(names).toEqual(expect.arrayContaining(['store_kind_releases', 'store_kind_current', 'store_kind_holds', 'store_kind_rollouts']));
    expect(names.filter((n) => n.startsWith('store_driver_'))).toEqual([]);
    expect(bindingColumns).toContain('kind');
  });

  it('moves onto the driver names on the next start, keeping every row, and the start after does nothing', async () => {
    const dir = await legacyDirectory();
    for (let start = 1; start <= 2; start += 1) {
      const host = new SqliteScopeHost({ dir });
      try {
        // Read through the host: a release uploaded before its pin, and the binding record.
        expect(await host.admin.getStoreDriverRelease(staff, 'graph', SHA)).toMatchObject({ driver: 'graph', sha256: SHA });
        expect((await host.admin.storeDriverState(staff, 'graph')).current).toMatchObject({ sha256: SHA, seq: 1 });
      } finally {
        await host.close();
      }
      const db = new Database(join(dir, '_directory.sqlite'), { readonly: true });
      try {
        const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
        expect(names.filter((n) => n.startsWith('store_kind_'))).toEqual([]);
        for (const table of [...DRIVER_TABLES, 'vertical_scope_stores']) {
          const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
          expect(columns).toContain('driver');
          expect(columns).not.toContain('kind');
        }
        expect(db.prepare('SELECT vertical_slug, binding, driver FROM vertical_scope_stores').all()).toEqual([
          { vertical_slug: 'docs', binding: 'GRAPH', driver: 'graph' },
        ]);
      } finally {
        db.close();
      }
    }
  });

  it('twin: a directory built after the rename starts with nothing to move', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'substrat-store-driver-fresh-'));
    dirs.push(dir);
    await new SqliteScopeHost({ dir }).close();
    const host = new SqliteScopeHost({ dir });
    try {
      expect(await host.admin.getStoreDriverRelease(staff, 'graph', SHA)).toBeUndefined();
    } finally {
      await host.close();
    }
  });
});
