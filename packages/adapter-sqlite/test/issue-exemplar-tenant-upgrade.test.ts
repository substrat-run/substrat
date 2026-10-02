import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteScopeHost } from '../src/index.js';

/**
 * #1632: `_substrat_issues.last_tenant_id` arrives on a directory that already holds issues.
 *
 * The column says whose ops failure an issue's exemplar was copied from, and erasure rewrites
 * an exemplar only for that tenant. An issue written before the column has no attribution,
 * so the upgrade backfills it once, from the retained ops-failure rows that carry the same
 * text under the same fingerprint — and only when they name exactly one tenant. Anything
 * short of proof stays NULL, which erasure skips.
 *
 * The old directory is staged by building one with this code and dropping the column: the
 * two releases' directories differ in that column and nothing else.
 */

const T1 = '01JTENANTAAAAAAAAAAAAAAAA1';
const T2 = '01JTENANTAAAAAAAAAAAAAAAA2';
const AT = '2099-01-01T00:00:00.000Z';

/** (fingerprint, exemplar) per issue, and the ops-failure rows that may prove its tenant. */
const ISSUES = [
  ['fp-one-tenant', 'one tenant said this'],
  ['fp-no-rows', 'nothing retained says this'],
  ['fp-two-tenants', 'two tenants said this'],
  ['fp-tenant-and-platform', 'a tenant and the platform said this'],
  ['fp-other-text', 'the exemplar'],
  ['fp-platform-only', 'only the platform said this'],
] as const;
const FAILURES = [
  ['01JFAILAAAAAAAAAAAAAAAAAA1', 'fp-one-tenant', 'one tenant said this', T1],
  ['01JFAILAAAAAAAAAAAAAAAAAA2', 'fp-two-tenants', 'two tenants said this', T1],
  ['01JFAILAAAAAAAAAAAAAAAAAA3', 'fp-two-tenants', 'two tenants said this', T2],
  ['01JFAILAAAAAAAAAAAAAAAAAA4', 'fp-tenant-and-platform', 'a tenant and the platform said this', T1],
  ['01JFAILAAAAAAAAAAAAAAAAAA5', 'fp-tenant-and-platform', 'a tenant and the platform said this', null],
  ['01JFAILAAAAAAAAAAAAAAAAAA6', 'fp-other-text', 'not the exemplar', T1],
  ['01JFAILAAAAAAAAAAAAAAAAAA7', 'fp-platform-only', 'only the platform said this', null],
  ['01JFAILAAAAAAAAAAAAAAAAAA8', 'fp-platform-only', 'only the platform said this', null],
] as const;
/** (owner kind, tenant) per issue: proven by one origin, or unknown. */
const EXPECTED = {
  'fp-one-tenant': ['tenant', T1],
  'fp-platform-only': ['platform', null],
  'fp-no-rows': [null, null],
  'fp-two-tenants': [null, null],
  'fp-tenant-and-platform': [null, null],
  'fp-other-text': [null, null],
};

describe('#1632: a directory whose issues predate exemplar ownership', () => {
  let dir: string;
  let file: string;

  const read = <T>(f: (db: Database.Database) => T): T => {
    const db = new Database(file, { readonly: true });
    try {
      return f(db);
    } finally {
      db.close();
    }
  };
  const hasColumn = () =>
    read((db) =>
      (db.prepare('PRAGMA table_info(_substrat_issues)').all() as { name: string }[]).some(
        (c) => c.name === 'last_owner_kind',
      ),
    );
  const attribution = () =>
    read((db) =>
      Object.fromEntries(
        (db.prepare('SELECT fingerprint, last_owner_kind, last_tenant_id FROM _substrat_issues').all() as {
          fingerprint: string;
          last_owner_kind: string | null;
          last_tenant_id: string | null;
        }[]).map((r) => [r.fingerprint, [r.last_owner_kind, r.last_tenant_id]]),
      ),
    );

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-issue-tenant-'));
    file = join(dir, '_directory.sqlite');
    await new SqliteScopeHost({ dir }).close();
    const db = new Database(file);
    db.exec('ALTER TABLE _substrat_issues DROP COLUMN last_owner_kind');
    db.exec('ALTER TABLE _substrat_issues DROP COLUMN last_tenant_id');
    const issue = db.prepare(
      `INSERT INTO _substrat_issues (fingerprint, operation, status, seen_count, first_seen, last_seen, last_message)
       VALUES (?, 'op', 'new', 1, ?, ?, ?)`,
    );
    for (const [fp, text] of ISSUES) issue.run(fp, AT, AT, text);
    const failure = db.prepare(
      `INSERT INTO _substrat_ops_failures (id, actor, operation, tenant_id, message, fingerprint, at)
       VALUES (?, 'staff', 'op', ?, ?, ?, ?)`,
    );
    for (const [id, fp, text, tenant] of FAILURES) failure.run(id, tenant, text, fp, AT);
    db.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is staged for real: the column is absent', () => {
    expect(hasColumn()).toBe(false);
  });

  it('adds the column and attributes only the rows one retained tenant proves', async () => {
    await new SqliteScopeHost({ dir }).close();
    expect(hasColumn()).toBe(true);
    expect(attribution()).toEqual(EXPECTED);
  });

  it('commits the columns only with their backfill — a crash between them is re-run on the next open', async () => {
    // The backfill's gate is "this open added the column". Committed separately, a column
    // that landed before a backfill that then failed would read as migrated for good. The
    // crash is a trigger that refuses the backfill's UPDATE, once.
    const db = new Database(file);
    db.exec(
      "CREATE TRIGGER crash_backfill BEFORE UPDATE ON _substrat_issues BEGIN SELECT RAISE(ABORT, 'crash mid-backfill'); END",
    );
    db.close();
    expect(() => new SqliteScopeHost({ dir })).toThrow(/crash mid-backfill/);
    // Rolled back whole: neither column survived the failed backfill.
    expect(hasColumn()).toBe(false);
    const restarted = new Database(file);
    restarted.exec('DROP TRIGGER crash_backfill');
    restarted.close();
    await new SqliteScopeHost({ dir }).close();
    expect(hasColumn()).toBe(true);
    expect(attribution()).toEqual(EXPECTED);
  });

  it('backfills once — a later open does not re-attribute', async () => {
    await new SqliteScopeHost({ dir }).close();
    // After the column exists its writer owns it; a NULL is a fact the writer recorded
    // (the platform's own exemplar), and a re-run must not turn it into a tenant's.
    const db = new Database(file);
    db.prepare("UPDATE _substrat_issues SET last_tenant_id = NULL, last_owner_kind = NULL WHERE fingerprint = 'fp-one-tenant'").run();
    db.close();
    await new SqliteScopeHost({ dir }).close();
    expect(attribution()['fp-one-tenant']).toEqual([null, null]);
  });
});
