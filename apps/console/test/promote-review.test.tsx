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

describe('MigrationDiffView: declared moves and discards (#2322)', () => {
  const view = (diff: Parameters<typeof migrationReviewOf>[0]) =>
    renderToString(createElement(MigrationDiffView, { review: migrationReviewOf(wire(diff)) }));

  it('shows each discard with its reason and each move, counted, and nothing for a migration declaring none', () => {
    const html = view(
      migrationsOnTop(
        [
          { moduleId: 'desk', version: '0001', sql: 'SELECT 1;' },
          { moduleId: 'desk', version: '0002', sql: 'DROP TABLE legacy;', discards: { legacy: 'unused since 2024' }, moves: { 'a.b': 'c.d' } },
        ],
        undefined,
      ),
    );
    expect(html).toContain('deliberately discards data in <!-- -->1<!-- --> place');
    expect(html).toContain('unused since 2024');
    expect(html).toContain('c.d');
    expect(html.match(/discards <span/g)).toHaveLength(1);
    expect(view(migrationsOnTop([{ moduleId: 'desk', version: '0001', sql: 's' }], undefined))).not.toMatch(/discards|moves/);
  });

  it('escapes a reason, makes bidi controls visible, and cuts a long one behind an expander', () => {
    const html = view(
      migrationsOnTop([{ moduleId: 'desk', version: '0002', sql: 's', discards: { t: `<img src=x>\u202E${'r'.repeat(400)}TAIL` } }], undefined),
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x&gt;&lt;U+202E&gt;');
    expect(html).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
    expect(html).toMatch(/<details[^>]*><summary[^>]*>.*… show all<\/summary>.*TAIL<\/details>/);
  });

  it('makes controls visible in a target, both ends of a move, the id and the SQL — not only the reason (#2322 r1)', () => {
    const c = (...p: number[]) => String.fromCodePoint(...p);
    const hostile = c(0x202e, 0x200b, 0x9b, 0x1b);
    const shown = '&lt;U+202E&gt;&lt;U+200B&gt;&lt;U+009B&gt;&lt;U+001B&gt;';
    const html = view(
      migrationsOnTop(
        [{ moduleId: 'desk', version: `0002${hostile}`, sql: `DROP TABLE t;${hostile}`, discards: { [`t${hostile}`]: 'why' }, moves: { [`a${hostile}`]: `b${hostile}` } }],
        undefined,
      ),
    );
    expect(html).toContain(`desk@0002${shown}`);
    expect(html).toContain(`DROP TABLE t;${shown}`);
    expect(html).toContain(`t${shown}`);
    expect(html).toContain(`a${shown}`);
    expect(html).toContain(`b${shown}`);
    expect(html).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  });

  it('cuts a many-line reason, and says "at least" or that a cut list cannot say (#2322 r1)', () => {
    const reason = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
    const html = view(migrationsOnTop([{ moduleId: 'desk', version: '0002', sql: 's', discards: { t: reason } }], undefined));
    const summary = /<summary[^>]*>([\s\S]*?)<\/summary>/.exec(html)?.[1] ?? '';
    expect(summary).toContain('line 5<!-- -->… show all');
    expect(summary).not.toContain('line 6');
    const cut = { baseline: 'none' as const, changed: [], total: 300, truncated: true };
    expect(view({ ...cut, added: [{ moduleId: 'd', version: '1', sql: 's', discards: { t: 'why' } }] })).toContain('at least <!-- -->1');
    expect(view({ ...cut, added: [{ moduleId: 'd', version: '1', sql: 's' }] })).toContain('cannot show whether a migration left out of it discards data');
  });

  it('shows a newline in an id or a target as a mark, and reads CRLF SQL as its lines (#2322 r2)', () => {
    const html = view(
      migrationsOnTop([{ moduleId: 'desk', version: '0007\nmoves x', sql: 'SELECT 1;\r\nSELECT 2;\rX', discards: { 'a\nmoves b': 'why' } }], undefined),
    );
    expect(html).toContain('desk@0007&lt;U+000A&gt;moves x');
    expect(html).toContain('a&lt;U+000A&gt;moves b');
    expect(html).toContain('SELECT 1;\nSELECT 2;&lt;U+000D&gt;X');
  });

  it('names a declarations-only edit as such', () => {
    const html = view(
      migrationsOnTop([{ moduleId: 'desk', version: '0001', sql: 's', discards: { t: 'why' } }], [{ moduleId: 'desk', version: '0001', sql: 's' }]),
    );
    expect(html).toContain('declarations edited after shipping');
  });
});
