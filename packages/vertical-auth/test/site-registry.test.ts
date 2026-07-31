import { beforeEach, describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  SITE_REGISTRY_DDL,
  recordSite,
  forgetSite,
  listSites,
  resolveSiteScope,
  type RegistrySql,
} from '../src/site-registry.js';

/**
 * The site registry, exercised against a real SQLite (the same engine the DO's `ctx.storage.sql`
 * is) through the `RegistrySql` seam. This is the logic behind the IdentityDO's site methods.
 */
describe('site registry', () => {
  let sql: RegistrySql;

  beforeEach(() => {
    const db = new Database(':memory:');
    for (const stmt of SITE_REGISTRY_DDL) db.exec(stmt);
    // Adapt better-sqlite3 to the `exec(query, ...params) → iterable rows` shape SqlStorage has.
    sql = {
      exec(query, ...params) {
        const stmt = db.prepare(query);
        if (stmt.reader) return stmt.all(...(params as never[])) as Record<string, unknown>[];
        stmt.run(...(params as never[]));
        return [];
      },
    };
  });

  it('records sites and lists them (both persisted, correct fields)', () => {
    recordSite(sql, '01SCOPECAFE', 'cafe', 'Cafe');
    recordSite(sql, '01SCOPEPADEL', 'padel', 'Padel Club');

    const sites = [...listSites(sql)].sort((a, b) => a.slug.localeCompare(b.slug));
    expect(sites).toEqual([
      { scopeId: '01SCOPECAFE', slug: 'cafe', name: 'Cafe' },
      { scopeId: '01SCOPEPADEL', slug: 'padel', name: 'Padel Club' },
    ]);
  });

  it('resolves a slug to its scope, and null for an unknown slug', () => {
    recordSite(sql, '01SCOPELAW', 'law', 'Law Office');
    expect(resolveSiteScope(sql, 'law')).toBe('01SCOPELAW');
    expect(resolveSiteScope(sql, 'does-not-exist')).toBeNull();
  });

  it('is idempotent — re-recording a scope updates name/slug in place, no duplicate', () => {
    recordSite(sql, '01SCOPEX', 'shop', 'Shop');
    recordSite(sql, '01SCOPEX', 'store', 'The Store'); // same scope, renamed

    expect(listSites(sql)).toEqual([{ scopeId: '01SCOPEX', slug: 'store', name: 'The Store' }]);
    expect(resolveSiteScope(sql, 'store')).toBe('01SCOPEX');
    expect(resolveSiteScope(sql, 'shop')).toBeNull(); // the old slug is gone
  });

  it('forgetSite drops a site — it no longer lists or resolves (idempotent)', () => {
    recordSite(sql, '01SCOPEA', 'cafe', 'Cafe');
    recordSite(sql, '01SCOPEB', 'padel', 'Padel');
    forgetSite(sql, '01SCOPEA');
    expect(listSites(sql).map((s) => s.slug)).toEqual(['padel']);
    expect(resolveSiteScope(sql, 'cafe')).toBeNull();
    forgetSite(sql, '01SCOPEA'); // idempotent
    expect(listSites(sql).map((s) => s.slug)).toEqual(['padel']);
  });
});
