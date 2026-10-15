import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { errorCodeOf } from '@substrat-run/contracts';
import {
  VERTICAL_SCOPE_STORES_DDL,
  forgetVerticalScopeStores,
  indexVersionScopeStores,
  kindDeclarationsOf,
  verticalScopeStoresOf,
  type SwitchSql,
} from '../src/index.js';

/**
 * #2286: every scope-store binding a vertical has declared, against a real SQLite. Each adapter
 * runs these same functions over its own directory; the scope-host contract suite holds the two
 * to them end to end.
 */
describe('a vertical\'s scope-store bindings, by any version (#2286)', () => {
  const fresh = (): SwitchSql => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE vertical_versions (
      id TEXT PRIMARY KEY, vertical_slug TEXT NOT NULL, manifest_json TEXT, created_at TEXT NOT NULL
    )`);
    db.exec(VERTICAL_SCOPE_STORES_DDL);
    return {
      all: (q, ...p) => db.prepare(q).all(...p) as Record<string, unknown>[],
      run: (q, ...p) => {
        db.prepare(q).run(...p);
      },
    };
  };
  const manifest = (scopeStores: { binding: string; kind: string }[]) => JSON.stringify({
    version: '1.0.0', entry: 'worker.js', compatibilityDate: '2025-01-01',
    digests: { manifest: 'm', permission: 'p', migration: 'g' }, scopeStores,
  });
  /** A version row, stored as a directory from before the table holds it: not indexed yet. */
  const stored = (sql: SwitchSql, id: string, manifestJson: string | null, at: string) =>
    sql.run('INSERT INTO vertical_versions (id, vertical_slug, manifest_json, created_at) VALUES (?, ?, ?, ?)', id, 'acme', manifestJson, at);
  const refusal = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return errorCodeOf(e);
    }
    return undefined;
  };

  it('keeps a binding a later version dropped', () => {
    const sql = fresh();
    indexVersionScopeStores(sql, 'acme', 'v1', manifest([{ binding: 'GRAPH', kind: 'graph' }, { binding: 'OLD', kind: 'graph' }]));
    indexVersionScopeStores(sql, 'acme', 'v2', manifest([{ binding: 'GRAPH', kind: 'graph' }]));
    expect(verticalScopeStoresOf(sql, 'acme')).toEqual([
      { binding: 'GRAPH', kind: 'graph' },
      { binding: 'OLD', kind: 'graph' },
    ]);
  });

  it('refuses a version that re-kinds a binding, and records nothing of it; the same kind again is fine', () => {
    const sql = fresh();
    indexVersionScopeStores(sql, 'acme', 'v1', manifest([{ binding: 'GRAPH', kind: 'graph' }]));
    expect(refusal(() => indexVersionScopeStores(sql, 'acme', 'v2', manifest([
      { binding: 'NOTES', kind: 'graph' },
      { binding: 'GRAPH', kind: 'counter' },
    ])))).toBe('conflict');
    // Judged before anything is written: neither the version nor its new NOTES is recorded.
    expect(sql.all('SELECT 1 FROM vertical_scope_store_versions WHERE version_id = ?', 'v2')).toEqual([]);
    expect(verticalScopeStoresOf(sql, 'acme')).toEqual([{ binding: 'GRAPH', kind: 'graph' }]);
    indexVersionScopeStores(sql, 'acme', 'v3', manifest([{ binding: 'GRAPH', kind: 'graph' }]));
    expect(verticalScopeStoresOf(sql, 'acme').find((s) => s.binding === 'GRAPH')).toEqual({ binding: 'GRAPH', kind: 'graph' });
  });

  it('indexes a version stored before the table on the first read, in the order versions were stored', () => {
    const sql = fresh();
    stored(sql, 'old', manifest([{ binding: 'OLD', kind: 'graph' }]), '2026-01-01T00:00:00.000Z');
    stored(sql, 'none', null, '2026-01-02T00:00:00.000Z');
    expect(verticalScopeStoresOf(sql, 'acme')).toEqual([{ binding: 'OLD', kind: 'graph' }]);
    expect(sql.all('SELECT first_version_id FROM vertical_scope_stores')).toEqual([{ first_version_id: 'old' }]);
    // Indexed once: a second read reads the record alone.
    expect(sql.all('SELECT COUNT(*) AS n FROM vertical_scope_store_versions')).toEqual([{ n: 2 }]);
    expect(verticalScopeStoresOf(sql, 'acme')).toEqual([{ binding: 'OLD', kind: 'graph' }]);
  });

  it('a publish judges a re-kind against a version stored before the record, and the vertical stays readable', () => {
    // v1 predates the record and nothing has read the vertical yet. A publish that re-kinds its
    // binding must be refused, not let through to wedge every later read. (The publish's own row
    // is rolled back with its transaction, so it is not in `vertical_versions` here.)
    const sql = fresh();
    stored(sql, 'v1', manifest([{ binding: 'GRAPH', kind: 'graph' }]), '2026-01-01T00:00:00.000Z');
    expect(refusal(() => indexVersionScopeStores(sql, 'acme', 'v2', manifest([{ binding: 'GRAPH', kind: 'counter' }]))))
      .toBe('conflict');
    expect(verticalScopeStoresOf(sql, 'acme')).toEqual([{ binding: 'GRAPH', kind: 'graph' }]);
  });

  it('refuses a version that declares one binding twice', () => {
    const sql = fresh();
    expect(refusal(() => indexVersionScopeStores(sql, 'acme', 'v1', manifest([
      { binding: 'GRAPH', kind: 'graph' },
      { binding: 'GRAPH', kind: 'graph' },
    ])))).toBe('conflict');
    expect(verticalScopeStoresOf(sql, 'acme')).toEqual([]);
  });

  it('a marked vertical is read by its keys alone: no version is looked at again', () => {
    const sql = fresh();
    indexVersionScopeStores(sql, 'acme', 'v1', manifest([{ binding: 'GRAPH', kind: 'graph' }]));
    expect(sql.all('SELECT vertical_slug FROM vertical_scope_store_indexed')).toEqual([{ vertical_slug: 'acme' }]);
    // Every version is added by a publish, which indexes it. A row that bypassed publish is not read.
    stored(sql, 'bypass', manifest([{ binding: 'OTHER', kind: 'graph' }]), '2026-01-03T00:00:00.000Z');
    expect(verticalScopeStoresOf(sql, 'acme')).toEqual([{ binding: 'GRAPH', kind: 'graph' }]);
  });

  it('refuses to name the bindings while a version\'s manifest cannot be read', () => {
    const sql = fresh();
    stored(sql, 'bad', '{nope', '2026-01-01T00:00:00.000Z');
    expect(refusal(() => verticalScopeStoresOf(sql, 'acme'))).toBe('unavailable');
    // And a re-kind among versions stored before publish refused it.
    const other = fresh();
    stored(other, 'a', manifest([{ binding: 'GRAPH', kind: 'graph' }]), '2026-01-01T00:00:00.000Z');
    stored(other, 'b', manifest([{ binding: 'GRAPH', kind: 'counter' }]), '2026-01-02T00:00:00.000Z');
    expect(refusal(() => verticalScopeStoresOf(other, 'acme'))).toBe('unavailable');
  });

  it('names the verticals that declare a kind, and as unreadable each that cannot say (#2300)', () => {
    const sql = fresh();
    const at = (vertical: string, id: string, json: string | null, when: string) =>
      sql.run('INSERT INTO vertical_versions (id, vertical_slug, manifest_json, created_at) VALUES (?, ?, ?, ?)', id, vertical, json, when);
    indexVersionScopeStores(sql, 'acme', 'a1', manifest([{ binding: 'GRAPH', kind: 'graph' }]));
    at('acme', 'a1', manifest([{ binding: 'GRAPH', kind: 'graph' }]), '2026-01-01T00:00:00.000Z');
    // Two versions stored before the record, the second re-kinding a binding: indexing throws.
    at('legacy', 'l1', manifest([{ binding: 'GRAPH', kind: 'graph' }]), '2026-01-01T00:00:00.000Z');
    at('legacy', 'l2', manifest([{ binding: 'GRAPH', kind: 'counter' }]), '2026-01-02T00:00:00.000Z');
    // A manifest that does not parse.
    at('broken', 'b1', '{nope', '2026-01-01T00:00:00.000Z');
    const declared = kindDeclarationsOf(sql, 'graph');
    expect(declared.unreadable).toEqual(['broken', 'legacy']);
    // The legacy vertical's first version still names its GRAPH store, indexed before the throw.
    expect(declared.verticals.find((v) => v.vertical === 'acme')).toEqual({ vertical: 'acme', stores: [{ binding: 'GRAPH', kind: 'graph' }] });
    expect(kindDeclarationsOf(sql, 'counter').verticals).toEqual([]);
  });

  it('forgets a deleted vertical\'s bindings', () => {
    const sql = fresh();
    indexVersionScopeStores(sql, 'acme', 'v1', manifest([{ binding: 'GRAPH', kind: 'graph' }]));
    forgetVerticalScopeStores(sql, 'acme');
    expect(verticalScopeStoresOf(sql, 'acme')).toEqual([]);
  });
});
