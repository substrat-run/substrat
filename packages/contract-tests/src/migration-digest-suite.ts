/**
 * Contract suite for the SQL digest a scope's migration journal records (#2066).
 *
 * A scope used to journal an applied migration by `(module_id, version)` alone, so a later
 * migration with the same version and different SQL was skipped as already applied and the
 * scope kept whichever schema it got first. Both adapters now record the SHA-256 of the exact
 * SQL beside the version, and hold an authored migration to it.
 *
 * A scope that "ran different SQL" is made the way an operator would meet one: its own dump,
 * with the journal's digest edited, restored onto it. That is an adapter-neutral door, and a
 * restore refreshes what the host believes was applied, so the next pass reads the edited row.
 *
 * `listMod` because it carries both kinds of migration: two authored versions and the
 * kernel-derived list index, which is versioned by its declaration and not held to a digest.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId, type ScopeDump } from '@substrat-run/contracts';
import { moduleMigrations, ulid, type ScopeHost } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { listMod } from './modules.js';

const MODULE = '@test/list';

/** `_substrat_migrations` as `sqlite_master` held it before #2066 — what a pre-digest dump carries. */
const PRE_DIGEST_JOURNAL_DDL = `CREATE TABLE _substrat_migrations (
    module_id TEXT NOT NULL,
    version TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    duration_ms INTEGER,
    rows_changed INTEGER,
    PRIMARY KEY (module_id, version)
  )`;
const AUTHORED = '0001-init';

/** SHA-256 hex, computed here with Web Crypto rather than through the kernel helper under test. */
const sha256 = async (text: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

export function migrationDigestContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture>,
): void {
  describe(`migration SQL digests (#2066): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const staff = platformActorId.parse(ulid());
    const alice = principalId.parse(ulid());
    /** The scope's own dump, taken once it has migrated — what every case restores from. */
    let clean: ScopeDump;
    /** The registered SQL's digest per version, derived set included. */
    let expected: Map<string, string>;

    const add = async () =>
      (await host.getScope(alice, t, s)).invoke('list/add', { id: ulid(), number: ulid(), status: 'open', kind: 'a' });

    /** This module's journal rows in a dump: version → { digest, appliedAt }. */
    const journalOf = (dump: ScopeDump) => {
      const table = dump.tables.find((tbl) => tbl.name === '_substrat_migrations')!;
      const col = (name: string) => table.columns.indexOf(name);
      return new Map(
        table.rows
          .filter((r) => r[col('module_id')] === MODULE)
          .map((r) => [String(r[col('version')]), { digest: r[col('sql_digest')] ?? null, appliedAt: r[col('applied_at')] }]),
      );
    };
    const journal = async () => journalOf(await host.admin.exportScope(staff, t, s));

    /** `clean`, with this module's journal digest rewritten for the versions `edit` names. */
    const restoreWith = async (edit: Record<string, string | null>) => {
      const tables = clean.tables.map((tbl) => {
        if (tbl.name !== '_substrat_migrations') return tbl;
        const col = (name: string) => tbl.columns.indexOf(name);
        return {
          ...tbl,
          rows: tbl.rows.map((r) => {
            const version = String(r[col('version')]);
            if (r[col('module_id')] !== MODULE || !(version in edit)) return r;
            const row = [...r];
            row[col('sql_digest')] = edit[version] ?? null;
            return row;
          }),
        };
      });
      await host.restoreScope(staff, t, s, { ...clean, tables });
    };

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(listMod);
      await host.admin.createTenant(staff, { id: t, slug: `digest-${ulid().toLowerCase()}`, name: 'Digest' });
      await host.admin.grantEntitlement(staff, t, 'list');
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'list-vertical' });
      await host.admin.activateScope(staff, t, s);
      await add();
      clean = await host.admin.exportScope(staff, t, s);
      expected = new Map(
        await Promise.all(moduleMigrations(listMod).map(async (m) => [m.version, await sha256(m.sql)] as const)),
      );
    });

    afterAll(async () => {
      await fixture?.cleanup();
    });

    it("a fresh scope records the SHA-256 of each migration's exact SQL, derived DDL included", async () => {
      // Three: the two authored versions and the kernel's list index, so neither kind is vacuous.
      expect([...expected.keys()]).toEqual(['0001-init', '0002-hold', expect.stringMatching(/^list\//)]);
      const rows = journalOf(clean);
      expect(new Map([...rows].map(([v, r]) => [v, r.digest]))).toEqual(expected);
    });

    it('the same digest is skipped: nothing re-runs, and the scope serves', async () => {
      const before = await journal();
      await restoreWith({});
      await expect(add()).resolves.toBeDefined();
      // Not re-applied: the rows are the ones the first pass wrote, applied_at and all.
      expect(await journal()).toEqual(before);
      expect((await host.migrateScope(t, s)).status).not.toBe('failed');
    });

    it('a different digest fails the scope closed, naming the module, the version and both digests', async () => {
      const ran = await sha256('CREATE TABLE list_orders (id TEXT PRIMARY KEY);');
      const registered = expected.get(AUTHORED)!;
      await restoreWith({ [AUTHORED]: ran });
      const named = new RegExp(
        `migration failed for ${MODULE}@${AUTHORED} — scope fails closed: .*applied sha256 ${ran}, registered sha256 ${registered}`,
      );
      await expect(add()).rejects.toThrow(named);
      // The sweep's door says the same, as the structured failure a failed migration leaves.
      const outcome = await host.migrateScope(t, s);
      expect(outcome).toEqual({ status: 'failed', failure: { version: `${MODULE}@${AUTHORED}`, error: expect.any(String) } });
      const failure = (outcome as { failure: { error: string } }).failure;
      expect(failure.error).toContain(ran);
      expect(failure.error).toContain(registered);
      // Recovery: the scope's journal agrees with the deployment again, and it serves.
      await restoreWith({});
      await expect(add()).resolves.toBeDefined();
    });

    it("a dump whose journal carries a NULL digest is refused, and the scope is left as it was", async () => {
      // A modern dump with an authored digest cleared — corrupted, or edited to hide a mismatch.
      // A NULL cannot say where it came from, so the journal's fence refuses it on the way in.
      const before = await journal();
      await expect(restoreWith({ [AUTHORED]: null })).rejects.toThrow('a migration journal row must carry its sql_digest (#2066)');
      expect(await journal()).toEqual(before);
      await expect(add()).resolves.toBeDefined();
    });

    /** `clean` with the journal reshaped: its `sql_digest` cells dropped, and its DDL set to `ddl`. */
    const withoutDigestColumn = (ddl?: string): ScopeDump => ({
      ...clean,
      tables: clean.tables.map((tbl) => {
        if (tbl.name !== '_substrat_migrations') return tbl;
        const at = tbl.columns.indexOf('sql_digest');
        return {
          ...tbl,
          ddl: ddl ?? tbl.ddl,
          columns: tbl.columns.filter((_, i) => i !== at),
          rows: tbl.rows.map((r) => r.filter((_, i) => i !== at)),
        };
      }),
    });

    it('a dump taken before digests were recorded restores with every journal row marked legacy, and serves', async () => {
      // The journal exactly as a pre-#2066 kernel exported it: the DDL `sqlite_master` held for it
      // then, and the columns that DDL declares.
      await host.restoreScope(staff, t, s, withoutDigestColumn(PRE_DIGEST_JOURNAL_DDL));
      const rows = await journal();
      expect([...rows.values()].map((r) => r.digest)).toEqual([...expected.keys()].map(() => 'legacy'));
      await expect(add()).resolves.toBeDefined();
      expect((await host.migrateScope(t, s)).status).not.toBe('failed');
      await restoreWith({});
    });

    it('a current dump with the digest column stripped is not taken for a legacy one: refused, the scope as it was', async () => {
      // Its journal DDL still declares sql_digest: neither a dump from before digests nor a whole
      // one from after. Read as legacy, it would unprotect every row.
      const before = await journal();
      await expect(host.restoreScope(staff, t, s, withoutDigestColumn())).rejects.toThrow(
        "the dump's _substrat_migrations declares sql_digest in its DDL but carries no such column",
      );
      expect(await journal()).toEqual(before);
      await expect(add()).resolves.toBeDefined();
    });

    it('derived DDL is held to its declaration, not its digest', async () => {
      const derived = [...expected.keys()].find((v) => v.startsWith('list/'))!;
      const other = await sha256('-- the kernel spelled this index another way');
      await restoreWith({ [derived]: other });
      await expect(add()).resolves.toBeDefined();
      expect((await host.migrateScope(t, s)).status).not.toBe('failed');
      // Recorded as what ran, never rewritten.
      expect((await journal()).get(derived)?.digest).toBe(other);
      await restoreWith({});
    });
  });
}
