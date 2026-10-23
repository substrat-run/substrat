import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { platformActorId } from '@substrat-run/contracts';
import { openVerticalOwnerRow } from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

/**
 * The ownership history (#2501) on a directory that predates it, and the one rule its table holds
 * by itself. The contract suite holds the rest on both adapters; this is what only a directory
 * FILE shows: a start over a directory whose verticals have no period backfills one, and at most
 * one period of a slug is ever open.
 */
const staff = platformActorId.parse('01JZ00000000000000000000ST');
const dirs: string[] = [];
const newDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'vertical-owners-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('vertical ownership history on a directory file (#2501)', () => {
  it('a start over verticals with no period opens one each, from its created_at, and only once', async () => {
    const dir = newDir();
    const first = new SqliteScopeHost({ dir });
    await first.admin.registerVertical(staff, { slug: 'acme-crm', name: 'CRM', source: 'builtin' });
    const createdAt = (await first.admin.listVerticals(staff))[0]!.createdAt;
    await first.close();

    // As a directory from before the history holds it: the vertical, and no period.
    const raw = new Database(join(dir, '_directory.sqlite'));
    raw.prepare('DELETE FROM _substrat_vertical_owners').run();
    raw.close();

    const second = new SqliteScopeHost({ dir });
    expect(await second.admin.listVerticalOwners!(staff, 'acme-crm')).toEqual([
      { slug: 'acme-crm', owner: null, since: createdAt, until: null },
    ]);
    await second.close();
    // Its twin: the next start finds the period open and opens nothing more.
    const third = new SqliteScopeHost({ dir });
    expect(await third.admin.listVerticalOwners!(staff, 'acme-crm')).toHaveLength(1);
    await third.close();
  });

  it('holds at most one open period of a slug; a closed one beside it is fine', async () => {
    const dir = newDir();
    const host = new SqliteScopeHost({ dir });
    await host.close();
    const raw = new Database(join(dir, '_directory.sqlite'));
    const sql = (statement: string, params: readonly (string | number | null)[]) => {
      const stmt = raw.prepare(statement);
      if (stmt.reader) return stmt.all(...params) as unknown[];
      stmt.run(...params);
      return [];
    };
    try {
      raw.prepare(`INSERT INTO _substrat_vertical_owners (slug, owner, since, until) VALUES ('acme-crm', NULL, '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')`).run();
      openVerticalOwnerRow(sql, 'acme-crm', null, '2026-03-01T00:00:00.000Z');
      expect(() => openVerticalOwnerRow(sql, 'acme-crm', null, '2026-04-01T00:00:00.000Z')).toThrow(/UNIQUE/);
    } finally {
      raw.close();
    }
  });
});
