import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { buildPermissionRegistry, migrationsOnTop, type PermissionRegistry } from '@substrat-run/contracts';
import {
  migrationReviewOf,
  permissionReviewOf,
  promoteAckSatisfied,
  readReview,
  type ReviewReader,
} from '../src/lib/promote';
import { createApi } from '../src/lib/api';
import { MigrationDiffView, PermissionDiffView } from '../src/views/VerticalDetail';

// Registries and migration diffs are built by the producers the routes serve, then sent
// through JSON as the wire does — not written by hand in the shape the view expects.
const mod = (id: string, keys: Array<[string, string]>) => ({
  manifest: { id, permissions: keys.map(([key, description]) => ({ key, description })) },
});
const registry = (rolePerms: string[]): PermissionRegistry =>
  JSON.parse(
    JSON.stringify(
      buildPermissionRegistry({
        modules: [mod('@substrat-run/engine-a', [['a:read', 'Read'], ['a:write', 'Write']])] as never,
        roles: [{ key: 'staff', permissions: rolePerms as never, source: 'vertical' }],
      }),
    ),
  );
const wire = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

const migrations = wire(
  migrationsOnTop(
    [
      { moduleId: 'm', version: '001', sql: 'CREATE TABLE a (id TEXT)' },
      { moduleId: 'm', version: '002', sql: 'ALTER TABLE a ADD COLUMN b TEXT' },
    ],
    [{ moduleId: 'm', version: '001', sql: 'CREATE TABLE a (id TEXT)' }],
  ),
);

const reader = (over: Partial<ReviewReader> = {}): ReviewReader => ({
  versionRegistry: async (_s, id) => ({ registry: id === 'old' ? registry(['a:read']) : registry(['a:read', 'a:write']) }),
  versionMigrations: async () => ({ migrations }),
  ...over,
});

describe('the console promote review (#1677)', () => {
  it('renders the permission diff a widened role produces, and each migration’s SQL', async () => {
    const r = await readReview(reader(), 'v', 'old', 'new', { permission: true, migration: true });
    expect(r.kind).toBe('ready');
    if (r.kind !== 'ready') return;
    const perm = renderToString(createElement(PermissionDiffView, { review: r.permission! }));
    expect(perm).toContain('staff');
    expect(perm).toContain('+a:write');
    const mig = renderToString(createElement(MigrationDiffView, { review: r.migration! }));
    expect(mig).toContain('m@002');
    expect(mig).toContain('ALTER TABLE a ADD COLUMN b TEXT');
    expect(mig).not.toContain('m@001');
  });

  it('a null registry is "cannot diff", never "no change" — on either side', async () => {
    for (const nullId of ['old', 'new']) {
      const r = await readReview(
        reader({ versionRegistry: async (_s, id) => ({ registry: id === nullId ? null : registry(['a:read']) }) }),
        'v', 'old', 'new', { permission: true, migration: false },
      );
      expect(r).toEqual({ kind: 'ready', permission: { kind: 'cannot-diff' }, migration: null });
    }
    const html = renderToString(createElement(PermissionDiffView, { review: { kind: 'cannot-diff' } }));
    expect(html).toContain('cannot be shown');
    expect(html).not.toContain('same permissions');
  });

  it('null migrations is "SQL not available", never "no migrations"', () => {
    const review = migrationReviewOf(null);
    expect(review).toEqual({ kind: 'unavailable' });
    const html = renderToString(createElement(MigrationDiffView, { review }));
    expect(html).toContain('not available');
    expect(html).not.toContain('No migration is new');
  });

  it('an empty itemised diff beside a moved digest names the unitemised field', () => {
    const a = registry(['a:read']);
    const b = { ...a, exports: [{ type: 'x.y' }] } as unknown as PermissionRegistry;
    const review = permissionReviewOf(a, b);
    expect(review.kind === 'diff' && review.unitemised).toEqual(['exports']);
    expect(renderToString(createElement(PermissionDiffView, { review }))).toContain('exports');
  });

  it('marks an entry whose SQL the read bound dropped, and a truncated answer', () => {
    const html = renderToString(
      createElement(MigrationDiffView, {
        review: migrationReviewOf({
          baseline: 'none',
          added: [{ moduleId: 'm', version: '009', sql: null }],
          changed: [],
          total: 300,
          truncated: true,
        }),
      }),
    );
    expect(html).toContain('over the read');
    expect(html).toContain('300');
  });

  it('reads only the diffs whose digest moved', async () => {
    const calls: string[] = [];
    await readReview(
      reader({
        versionRegistry: async () => { calls.push('registry'); return { registry: null }; },
        versionMigrations: async () => { calls.push('migrations'); return { migrations: null }; },
      }),
      'v', 'old', 'new', { permission: false, migration: true },
    );
    expect(calls).toEqual(['migrations']);
  });

  it('a failed read is an error, and the acknowledgement stays required', async () => {
    const r = await readReview(
      reader({ versionRegistry: async () => { throw new Error('502 bad gateway'); } }),
      'v', 'old', 'new', { permission: true, migration: true },
    );
    expect(r).toEqual({ kind: 'error', message: '502 bad gateway' });
    // The gate is the digests, not the review: unrenderable or not, it is not satisfied.
    expect(promoteAckSatisfied({ permission: true, migration: true, exportBreak: false }, {})).toBe(false);
  });

  it('the client asks the routes the staff API serves, base included', async () => {
    const urls: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(url.includes('/registry') ? { registry: null } : { migrations: null }), { status: 200 });
    }) as typeof fetch;
    try {
      const api = createApi(null, '/api');
      expect(await api.versionRegistry('fsm', 'v1')).toEqual({ registry: null });
      expect(await api.versionMigrations('fsm', 'v2', 'v1')).toEqual({ migrations: null });
      expect(await api.versionMigrations('fsm', 'v2')).toEqual({ migrations: null });
    } finally {
      globalThis.fetch = orig;
    }
    expect(urls).toEqual([
      '/api/verticals/fsm/versions/v1/registry',
      '/api/verticals/fsm/versions/v2/migrations?base=v1',
      '/api/verticals/fsm/versions/v2/migrations',
    ]);
  });
});
