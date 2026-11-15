import { afterEach, describe, expect, it } from 'vitest';
import type { MigrationDiff, PermissionRegistry } from '@substrat-run/contracts';
import { formatPromoteReview, needsOf, readPromoteReview } from '../src/promote-review.js';
import { readStatus } from '../src/status.js';

/**
 * `substrat promote --review-only` and `substrat status`: the promote review read without
 * promoting, under the dashboard dialog's rules. The plane is a fetch stub over the routes the
 * CLI reads; a POST of any kind fails the stub, so "never promotes" is held by every test.
 */

const reg = (keys: string[]): PermissionRegistry =>
  ({
    permissions: keys.map((key) => ({ key, description: key, declaredBy: ['garden'] })),
    roles: [{ key: 'gardener', permissions: keys, source: 'vertical' }],
    entityGrants: [],
  }) as unknown as PermissionRegistry;

const migrations = (total: number): MigrationDiff => ({
  baseline: 'version',
  added: total ? [{ moduleId: 'garden', version: '0002-beds', sql: 'CREATE TABLE garden_bed (id TEXT);' }] : [],
  changed: [],
  total,
  truncated: false,
});

const REVIEW = { base: 'v1', digest: 'a'.repeat(64) };

const orig = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = orig;
});

function plane(o: {
  serving: string | null;
  registries?: Record<string, PermissionRegistry | null>;
  migrations?: MigrationDiff | null;
  breaks?: { affected: { scopeId: string; vertical: string; type: string; schemaVersion: number; incoming: number | null }[]; otherTenants?: number };
}) {
  const seen: string[] = [];
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    seen.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
    if ((init?.method ?? 'GET') !== 'GET') return new Response('a review never writes', { status: 599 });
    const p = url.pathname;
    if (p.endsWith('/verticals')) return Response.json({ entries: [{ slug: 't-acme/garden' }], nextCursor: null });
    if (p.endsWith('/versions')) {
      return Response.json({
        entries: [
          { id: 'v1', version: '0.0.5', admission: 'admitted' },
          { id: 'v2', version: '0.0.6', admission: 'admitted' },
          { id: 'v3', version: '0.0.7', admission: 'rejected' },
        ],
        nextCursor: null,
      });
    }
    if (p.endsWith('/channels')) {
      return Response.json({ entries: o.serving ? [{ channel: 'prod', versionId: o.serving, servingVersionId: o.serving }] : [], nextCursor: null });
    }
    if (p.endsWith('/registry')) {
      const id = p.split('/').at(-2)!;
      return Response.json({ registry: o.registries?.[id] ?? reg(['garden:read']) });
    }
    if (p.endsWith('/migrations')) return Response.json({ migrations: o.migrations === undefined ? migrations(0) : o.migrations, review: REVIEW });
    if (p.endsWith('/promote-impact')) return Response.json(o.breaks ?? { affected: [] });
    if (p.endsWith('/previews')) return Response.json([{ scopeId: 's1', tag: 'pr-12', versionId: 'v2', forkedFrom: null, expiresAt: null, hostname: 'h', url: 'https://pr-12.example' }]);
    if (p.endsWith('/ops-failures')) {
      return Response.json({
        entries: [{ id: 'f1', at: '2026-11-15T11:34:00Z', operation: 'deploy.upload', stage: null, status: 409, message: 'promotion changes migrations', reference: null, version: 'v2' }],
        nextCursor: null,
      });
    }
    return new Response('unexpected', { status: 599 });
  }) as typeof fetch;
  return seen;
}

const opts = { controlPlaneUrl: 'http://cp/api', header: {}, slug: 'garden', channel: 'prod' };

describe('the acknowledgements a review needs: the dialog’s rules', () => {
  const v = (versionId: string) => ({ versionId, version: null });
  const base = { serving: v('v1'), incoming: v('v2'), servingRegistry: reg(['a']), incomingRegistry: reg(['a']), migrations: migrations(0), exportBreaks: null };
  it.each([
    ['a first promotion asks nothing', { ...base, serving: null }, []],
    ['promoting what serves asks nothing', { ...base, incoming: v('v1') }, []],
    ['no change asks nothing', base, []],
    ['a registry kept by neither side cannot be compared, so it asks', { ...base, servingRegistry: null }, ['--ack-permissions']],
    ['a changed registry asks', { ...base, incomingRegistry: reg(['a', 'b']) }, ['--ack-permissions']],
    ['SQL not carried is not "no change"', { ...base, migrations: null }, ['--ack-migrations']],
    ['an added migration asks', { ...base, migrations: migrations(1) }, ['--ack-migrations']],
    ['an app counted in another tenant asks', { ...base, exportBreaks: { affected: [], otherTenants: 1 } }, ['--ack-export-break']],
  ])('%s', (_, review, needs) => {
    expect(needsOf(review)).toEqual(needs);
  });
});

describe('substrat promote --review-only', () => {
  it('reviews the newest ADMITTED version against what prod serves, and prints the line a person runs', async () => {
    const seen = plane({
      serving: 'v1',
      registries: { v2: reg(['garden:read', 'garden:write']) },
      migrations: migrations(1),
      breaks: { affected: [{ scopeId: 's9', vertical: 'board', type: 'garden.planted', schemaVersion: 1, incoming: null }] },
    });
    const review = await readPromoteReview(opts);
    // v3 is newer but rejected: it cannot be promoted, so it is not what waits.
    expect(review.incoming).toEqual({ versionId: 'v2', version: '0.0.6' });
    expect(review.needs).toEqual(['--ack-permissions', '--ack-migrations', '--ack-export-break']);
    expect(review.command).toBe(`substrat promote garden --version v2 --ack-permissions --ack-migrations --ack-export-break --review v1:${'a'.repeat(64)}`);
    expect(seen).toContain('GET /api/verticals/garden/channels/prod/promote-impact?versionId=v2');
    const text = formatPromoteReview(review).join('\n');
    expect(text).toContain('prod serves v1 (0.0.5); promoting v2 (0.0.6).');
    expect(text).toMatch(/\+ garden:write/);
    expect(text).toMatch(/\+ garden 0002-beds\n {6}CREATE TABLE garden_bed/);
    expect(text).toContain('board (scope s9) imports garden.planted v1 — this version no longer exports it');
  });

  it('a version prod already serves: nothing to promote, and no diff is read', async () => {
    const seen = plane({ serving: 'v2' });
    const review = await readPromoteReview({ ...opts, versionId: 'v2' });
    expect(review.needs).toEqual([]);
    expect(formatPromoteReview(review)).toEqual(['prod already serves v2 (0.0.6); there is nothing to promote.']);
    expect(seen.some((s) => s.includes('/migrations') || s.includes('/promote-impact'))).toBe(false);
  });
});

describe('substrat status', () => {
  it('what prod serves, the promote waiting and what it needs, previews, and failures under the registry id', async () => {
    const seen = plane({ serving: 'v1', migrations: migrations(1) });
    const status = await readStatus({ controlPlaneUrl: 'http://cp/api', header: {}, slug: 'garden' });
    expect(status.prod).toEqual({ versionId: 'v1', version: '0.0.5', servingVersionId: 'v1' });
    expect(status.waiting).toMatchObject({ versionId: 'v2', version: '0.0.6', needs: ['--ack-migrations'] });
    expect(status.versions.map((v) => v.id)).toEqual(['v3', 'v2', 'v1']);
    expect(status.previews).toEqual([{ tag: 'pr-12', url: 'https://pr-12.example', versionId: 'v2', expiresAt: null }]);
    expect(status.failures.map((f) => f.operation)).toEqual(['deploy.upload']);
    // The failure record matches the registry id exactly, not the bare slug.
    expect(seen).toContain('GET /api/ops-failures?vertical=t-acme%2Fgarden&limit=5');
  });

  it('prod on the newest admitted version: nothing waits', async () => {
    plane({ serving: 'v2' });
    expect((await readStatus({ controlPlaneUrl: 'http://cp/api', header: {}, slug: 'garden' })).waiting).toBeNull();
  });
});
