import { describe, expect, it } from 'vitest';
import {
  deployManifest,
  storedDeployManifest,
  migrationsOnTop,
  reviewText,
  discardCount,
  DECLARED_MIGRATIONS_SQL_BYTES_MAX,
  MIGRATION_READ_MAX,
  MIGRATION_READ_SQL_BYTES_MAX,
} from '../src/index.js';

const m = (version: string, sql = `-- ${version}`) => ({ moduleId: 'helpdesk', version, sql });

describe('migrationsOnTop (#1677)', () => {
  it('lists what the base lacks, in the incoming order, and keys on module AND version', () => {
    const other = { moduleId: 'other', version: '0001', sql: 'x' };
    const diff = migrationsOnTop([m('0001'), other, m('0002')], [m('0001')]);
    expect(diff.added).toEqual([other, m('0002')]);
    expect(diff).toMatchObject({ baseline: 'version', changed: [], total: 2, truncated: false });
  });

  it('adds nothing when the base is the same set', () => {
    expect(migrationsOnTop([m('0001')], [m('0001')])).toMatchObject({ added: [], changed: [], total: 0 });
  });

  it('bounds the count, and says so', () => {
    const many = Array.from({ length: MIGRATION_READ_MAX + 5 }, (_, i) => m(String(i).padStart(4, '0')));
    const diff = migrationsOnTop(many, []);
    expect(diff.added).toHaveLength(MIGRATION_READ_MAX);
    expect(diff).toMatchObject({ total: MIGRATION_READ_MAX + 5, truncated: true });
  });

  it('bounds the SQL bytes, keeping each id with `sql: null` past the budget', () => {
    const half = 'x'.repeat(MIGRATION_READ_SQL_BYTES_MAX / 2 + 1);
    const diff = migrationsOnTop([m('0001', half), m('0002', half), m('0003', 'small')], []);
    expect(diff.added.map((e) => [e.version, e.sql === null])).toEqual([
      ['0001', false],
      ['0002', true],
      ['0003', false],
    ]);
    expect(diff.truncated).toBe(true);
  });

  it('spends the budget on an edited shipped migration before the added ones', () => {
    const big = 'x'.repeat(MIGRATION_READ_SQL_BYTES_MAX);
    const diff = migrationsOnTop([m('0001', big), m('0002', 'new')], [m('0001', 'old')]);
    expect(diff.changed[0]?.sql).toBe(big);
    expect(diff.added[0]).toEqual({ moduleId: 'helpdesk', version: '0002', sql: null });
  });
});

describe('deployManifest.migrations', () => {
  const base = {
    version: '1.0.0',
    entry: 'index.js',
    compatibilityDate: '2026-07-01',
    registry: { permissions: [], roles: [], entityGrants: [] },
    digests: { manifest: 'm', permission: 'p', migration: 'g' },
  };

  it('is optional, and absence stays absence (not `[]`)', () => {
    expect(deployManifest.parse(base).migrations).toBeUndefined();
    expect(deployManifest.parse({ ...base, migrations: [] }).migrations).toEqual([]);
  });

  it('refuses more SQL than the cap at the trust boundary', () => {
    const sql = 'x'.repeat(DECLARED_MIGRATIONS_SQL_BYTES_MAX);
    expect(deployManifest.safeParse({ ...base, migrations: [m('1', sql)] }).success).toBe(true);
    expect(deployManifest.safeParse({ ...base, migrations: [m('1', sql), m('2', 'y')] }).success).toBe(false);
  });

  it('reads a STORED manifest over the push cap — the cap may move, history stays readable', () => {
    const sql = 'x'.repeat(DECLARED_MIGRATIONS_SQL_BYTES_MAX);
    const over = { ...base, migrations: [m('1', sql), m('2', 'y')] };
    expect(deployManifest.safeParse(over).success).toBe(false);
    expect(storedDeployManifest.parse(over).migrations).toHaveLength(2);
  });
});

describe('migrationsOnTop carries the declared moves and discards (#2322)', () => {
  const declared = (version: string, extra: { moves?: Record<string, string>; discards?: Record<string, string> }, sql = `-- ${version}`) => ({
    ...m(version, sql),
    ...extra,
  });

  it('lists a declared migration with its moves and discards, and an undeclared one with neither key', () => {
    const d = declared('0002', { moves: { legacy: 'orders' }, discards: { 'orders.note': 'free text nobody reads' } });
    const diff = migrationsOnTop([m('0001'), d], []);
    expect(diff.added[0]).toEqual(m('0001'));
    expect(diff.added[1]).toEqual(d);
    expect(diff.truncated).toBe(false);
  });

  it('lists a shipped migration whose declarations alone changed, as `edited: declarations`', () => {
    const was = declared('0002', { discards: { 'orders.note': 'unused' } });
    const now = declared('0002', { discards: { 'orders.note': 'unused since 2024' } });
    const diff = migrationsOnTop([now], [was]);
    expect(diff.changed).toEqual([{ ...now, edited: 'declarations' }]);
    expect(diff.total).toBe(1);
    // A declaration added to, or removed from, a shipped migration is an edit too.
    expect(migrationsOnTop([now], [m('0002')]).changed[0]?.edited).toBe('declarations');
    expect(migrationsOnTop([m('0002')], [now]).changed[0]).toEqual({ ...m('0002'), edited: 'declarations' });
  });

  it('marks a SQL edit `edited: sql`, and reads key order as no edit at all', () => {
    expect(migrationsOnTop([m('0001', 'new')], [m('0001', 'old')]).changed[0]?.edited).toBe('sql');
    const a = declared('0001', { discards: { a: 'x', b: 'y' } });
    const b = declared('0001', { discards: { b: 'y', a: 'x' } });
    expect(migrationsOnTop([a], [b]).total).toBe(0);
  });

  it('charges the declarations before the SQL, and flags them left out rather than dropping them silently', () => {
    const big = 'x'.repeat(MIGRATION_READ_SQL_BYTES_MAX);
    const reason = 'r'.repeat(100);
    // The first entry's SQL fills the budget once its declaration is paid for.
    const first = declared('0001', { discards: { t: reason } }, 'x'.repeat(MIGRATION_READ_SQL_BYTES_MAX - 101));
    const second = declared('0002', { discards: { u: reason } }, 'small');
    const diff = migrationsOnTop([first, second], []);
    expect(diff.added[0]).toMatchObject({ discards: { t: reason } });
    expect(diff.added[0]?.sql).not.toBeNull();
    expect(diff.added[1]).toEqual({ moduleId: 'helpdesk', version: '0002', sql: null, declarationsLeftOut: true });
    expect(diff.truncated).toBe(true);
    // Declarations still fit when the SQL does not.
    const third = migrationsOnTop([declared('0003', { moves: { a: 'b' } }, big + 'x')], []);
    expect(third.added[0]).toEqual({ moduleId: 'helpdesk', version: '0003', sql: null, moves: { a: 'b' } });
  });

  it('shows what was stored, whatever digest the pusher sent: the diff never reads `digests`', () => {
    // The diff's inputs are the stored migrations alone; a manifest whose client-computed
    // digest left the declarations out still has them in its stored list, and so in the answer.
    const stored = deployManifest.parse({
      version: '1.0.0',
      entry: 'index.js',
      compatibilityDate: '2026-07-01',
      registry: { permissions: [], roles: [], entityGrants: [] },
      digests: { manifest: 'm', permission: 'p', migration: 'digest-of-a-declaration-free-set' },
      migrations: [declared('0001', { discards: { orders: 'replaced by invoices' } })],
    });
    expect(migrationsOnTop(stored.migrations ?? [], [m('0001')]).changed[0]?.discards).toEqual({ orders: 'replaced by invoices' });
  });
});

describe('deployManifest.migrations declarations (#2322)', () => {
  const base = {
    version: '1.0.0',
    entry: 'index.js',
    compatibilityDate: '2026-07-01',
    registry: { permissions: [], roles: [], entityGrants: [] },
    digests: { manifest: 'm', permission: 'p', migration: 'g' },
  };
  const ok = (extra: Record<string, unknown>) =>
    deployManifest.safeParse({ ...base, migrations: [{ ...m('0001'), ...extra }] }).success;

  it('accepts moves and discards spelled as SqlMigration spells them', () => {
    expect(ok({ moves: { 'a.b': 'c.d' }, discards: { e: 'why' } })).toBe(true);
  });

  it('refuses a discard with no reason, or a blank one', () => {
    expect(ok({ discards: { e: '' } })).toBe(false);
    expect(ok({ discards: { e: '  \n' } })).toBe(false);
  });

  it('refuses an empty record: no declarations is an absent field', () => {
    expect(ok({ moves: {} })).toBe(false);
    expect(ok({ discards: {} })).toBe(false);
  });

  it('bounds the entries, the targets and the reason', () => {
    const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`t${i}`, 'why']));
    expect(ok({ discards: many })).toBe(false);
    expect(ok({ discards: { ['t'.repeat(201)]: 'why' } })).toBe(false);
    expect(ok({ discards: { t: 'w'.repeat(2001) } })).toBe(false);
    expect(ok({ moves: { a: '' } })).toBe(false);
  });

  it('counts declarations toward the byte cap', () => {
    const sql = 'x'.repeat(DECLARED_MIGRATIONS_SQL_BYTES_MAX - 4);
    expect(ok({ sql, discards: { t: 'why' } })).toBe(true);
    expect(ok({ sql, discards: { t: 'why?' } })).toBe(false);
  });
});

describe('reviewText and discardCount (#2322)', () => {
  it('makes every bidi control visible and keeps the rest verbatim', () => {
    expect(reviewText('keeps‮sdrop')).toBe('keeps<U+202E>sdrop');
    expect(reviewText('⁦a⁩‎‏؜‪')).toBe('<U+2066>a<U+2069><U+200E><U+200F><U+061C><U+202A>');
    expect(reviewText('<b>"x"</b>\né')).toBe('<b>"x"</b>\né');
  });

  it('counts the shown discards, edited and added', () => {
    const diff = migrationsOnTop(
      [
        { moduleId: 'a', version: '1', sql: 's', discards: { t: 'why', u: 'why' } },
        { moduleId: 'a', version: '2', sql: 's', moves: { x: 'y' } },
        { moduleId: 'a', version: '3', sql: 'new', discards: { v: 'why' } },
      ],
      [{ moduleId: 'a', version: '3', sql: 'old' }],
    );
    expect(discardCount(diff)).toBe(3);
  });
});
