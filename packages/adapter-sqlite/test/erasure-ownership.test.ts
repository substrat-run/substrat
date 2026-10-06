import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  dataSubjectId,
  errorCodeOf,
  moduleManifest,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
} from '@substrat-run/contracts';
import { UNSAFE_allowAllChecker, ulid, webCryptoSecretBox, type ModuleRegistration } from '@substrat-run/kernel';
import { erasureOtherMod, erasureSquatterMod as squatter } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';

/**
 * #2068, Codex #2084 r2: a second module whose migration says `CREATE TABLE IF NOT EXISTS` on the
 * first module's table created nothing, and so owns nothing. Its declared erasure on that table
 * passes registration (the migration TEXT reads as a creation) and is refused by the erasure,
 * which checks the ownership the scope recorded as the migrations actually ran.
 *
 * On this host only: the Durable-Object kit carries one module set on every scope, and a
 * squatter there would refuse every other suite's erasure. The ownership recording itself is
 * proven on both adapters by `subjectErasureContractSuite`.
 */
describe('an erasure on a table another module created is refused, IF NOT EXISTS or not (#2068)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-ownership-'));
  const host = new SqliteScopeHost({
    dir,
    checker: UNSAFE_allowAllChecker,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const staff = platformActorId.parse(ulid());
  const db = () =>
    (host as unknown as { runtime(t: unknown, s: unknown): { db: { prepare(q: string): { all(...a: unknown[]): unknown[]; run(...a: unknown[]): unknown } } } })
      .runtime(t, s).db;

  beforeAll(async () => {
    host.registerModule(erasureOtherMod);
    // The registration-time check reads the migration text, sees a CREATE, and lets it through.
    host.registerModule(squatter);
    await host.admin.createTenant(staff, { id: t, slug: `own-${t.toLowerCase()}`, name: 'Ownership' });
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'ownership' });
    await host.admin.activateScope(staff, t, s);
    await host.getScope(principalId.parse(ulid()), t, s);
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('records the table as the module whose migration actually created it', () => {
    expect(db().prepare("SELECT module_id FROM _substrat_table_owners WHERE table_name = 'er_other'").all()).toEqual([
      { module_id: '@test/erasure-other' },
    ]);
  });

  it("refuses the squatter's erasure before anything is written, and the key survives", async () => {
    const who = dataSubjectId.parse(ulid());
    db().prepare('INSERT INTO er_other (id, secret) VALUES (?, ?)').run(who, 'theirs');
    const [sealed] = await host.admin.sealSubjectPayloads(staff, t, s, [{ subjectId: who, plaintext: 'in the backup' }]);
    const err = await host.admin.shredSubject(staff, t, s, who).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(errorCodeOf(err)).toBe('precondition_failed');
    expect(String((err as Error).message)).toMatch(/'er_other', which this scope does not record/);
    expect(db().prepare('SELECT secret FROM er_other WHERE id = ?').all(who)).toEqual([{ secret: 'theirs' }]);
    expect(await host.admin.openSubjectPayloads(staff, t, s, [{ subjectId: who, sealed: sealed! }])).toEqual(['in the backup']);
  });
});

/**
 * Codex #2084 r3: an authored migration that writes the ledger would forge ownership. It is
 * refused before it runs, the migration rolls back whole — its own table included — and the
 * scope fails closed. On this host only, for the squatter's reason: a forging module in the
 * Durable-Object kit would fail every scope. The guard is the same kernel call on both.
 */
const forger: ModuleRegistration = {
  manifest: moduleManifest.parse({
    id: '@test/erasure-forger',
    version: '1.0.0',
    kernelContract: '^0.0.1',
    permissions: [],
    events: { emits: [], consumes: [] },
    migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
    attachmentTargets: [],
    entitlementKey: 'erasure-forger',
  }),
  migrations: [
    {
      version: '0001',
      sql:
        'CREATE TABLE forger_own (id TEXT PRIMARY KEY); ' +
        "INSERT INTO _substrat_table_owners VALUES ('er_other', '@test/erasure-forger', 'migration', 'now');",
    },
  ],
};

describe('a migration that writes the ownership ledger is refused and rolls back (#2068)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-forger-'));
  const host = new SqliteScopeHost({ dir, checker: UNSAFE_allowAllChecker });
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const staff = platformActorId.parse(ulid());
  const db = () =>
    (host as unknown as { runtime(t: unknown, s: unknown): { db: { prepare(q: string): { all(...a: unknown[]): unknown[] } } } })
      .runtime(t, s).db;

  beforeAll(async () => {
    host.registerModule(erasureOtherMod);
    host.registerModule(forger);
    await host.admin.createTenant(staff, { id: t, slug: `forge-${t.toLowerCase()}`, name: 'Forge' });
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'forge' }).catch(() => undefined);
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails the scope closed, keeps the true owner, and leaves none of the migration behind', async () => {
    const err = await host.getScope(principalId.parse(ulid()), t, s).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(String((err as Error)?.message)).toMatch(/names _substrat_table_owners/);
    expect(db().prepare("SELECT module_id FROM _substrat_table_owners WHERE table_name = 'er_other'").all()).toEqual([
      { module_id: '@test/erasure-other' },
    ]);
    expect(db().prepare("SELECT name FROM sqlite_master WHERE name = 'forger_own'").all()).toEqual([]);
    expect(
      db().prepare("SELECT 1 FROM _substrat_migrations WHERE module_id = '@test/erasure-forger'").all(),
    ).toEqual([]);
  });
});
