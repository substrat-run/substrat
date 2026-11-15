import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SESSION_MAXAGE } from '@substrat-run/oidc-rp';
import { SESSION_REFRESH_DDL, SESSION_REFRESH_MAX_AGE_MS, sqlRefreshStore, type SqlRefreshStoreOptions } from '../src/session-refresh.js';
import type { RegistrySql } from '../src/site-registry.js';

/** The master's refresh-token store sweeps rows whose session has expired (#3179). */

function storeAt(options: Omit<SqlRefreshStoreOptions, 'now'>) {
  const db = new Database(':memory:');
  for (const stmt of SESSION_REFRESH_DDL) db.exec(stmt);
  const sql: RegistrySql = {
    exec(query, ...params) {
      const stmt = db.prepare(query);
      if (stmt.reader) return stmt.all(...params) as Record<string, unknown>[];
      stmt.run(...params);
      return [];
    },
  };
  const clock = { ms: Date.UTC(2026, 10, 15) };
  const store = sqlRefreshStore(sql, { ...options, now: () => new Date(clock.ms) });
  const sids = () => (db.prepare('SELECT sid FROM session_refresh ORDER BY sid').all() as { sid: string }[]).map((r) => r.sid);
  return { store, clock, sids };
}

it('sweeps a row older than the session lifetime on the next put, and keeps a younger one and the same person on another device', async () => {
  const { store, clock, sids } = storeAt({ maxAgeMs: 1000 });
  const start = clock.ms;
  await store.put('sid-old', { sub: 'ada', refreshToken: 'rt-old' });
  clock.ms = start + 500;
  await store.put('sid-device-2', { sub: 'ada', refreshToken: 'rt-2' });
  // Exactly one lifetime old: the session's last instant, still kept.
  clock.ms = start + 1000;
  await store.put('sid-boundary', { sub: 'bea', refreshToken: 'rt-b' });
  expect(sids()).toEqual(['sid-boundary', 'sid-device-2', 'sid-old']);
  // Ada signs in again: only her expired session's row goes.
  clock.ms = start + 1001;
  await store.put('sid-new', { sub: 'ada', refreshToken: 'rt-new' });
  expect(sids()).toEqual(['sid-boundary', 'sid-device-2', 'sid-new']);
  expect(await store.get('sid-old')).toBeNull();
});

it('deletes at most one batch per put', async () => {
  const { store, clock, sids } = storeAt({ maxAgeMs: 1000, sweepBatch: 2 });
  for (const n of [1, 2, 3, 4, 5]) await store.put(`stale-${n}`, { sub: 'ada', refreshToken: `rt-${n}` });
  clock.ms += 5000;
  await store.put('fresh-1', { sub: 'ada', refreshToken: 'rt-f1' });
  expect(sids().filter((s) => s.startsWith('stale-'))).toHaveLength(3);
  await store.put('fresh-2', { sub: 'ada', refreshToken: 'rt-f2' });
  expect(sids()).toEqual(['fresh-1', 'fresh-2', 'stale-5']);
});

it('defaults the lifetime to the session cookie oidc-rp mints', () => {
  expect(SESSION_REFRESH_MAX_AGE_MS).toBe(SESSION_MAXAGE * 1000);
});
