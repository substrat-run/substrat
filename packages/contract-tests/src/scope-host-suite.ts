import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectorCalls, connectorTestFetch, resetConnectorCalls } from './connector-fixture.js';
import {
  connectionId,
  moduleManifest,
  orgId,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type OrgId,
  type PrincipalId,
  type TenantId,
} from '@substrat-run/contracts';
import { runPlatformSweep, ulid, type OperationHandler, type ScopeHost } from '@substrat-run/kernel';
import {
  billedMod,
  contractTestBareOps,
  contractTestInitialModules,
  gateModManifest,
  lateMod,
  testModManifest,
  victimModManifest,
} from './modules.js';

export interface ScopeHostFixture {
  host: ScopeHost;
  cleanup(): Promise<void>;
}

interface OutboxRow {
  id: string;
  type: string;
  actor: unknown;
  occurred_at: string;
  tenant_id: string;
  scope_id: string;
  pii_class: string;
  subject_id: string | null;
}

/** Adapter capability flags — everything an adapter cannot honor identically. */
export interface ScopeHostSuiteOptions {
  /**
   * Whether the adapter supports registering a module AFTER a scope was first
   * accessed (runtime registration). The pure adapter does; the Cloudflare
   * adapter closes its ScopeDO over a code-time module set, so it does not. When
   * `false`, the single late-registration test is skipped — every other test is
   * shared unchanged (D-14).
   */
  supportsRuntimeRegistration?: boolean;
}

/**
 * The scope-host contract suite (design doc §11). Every adapter — pure SQLite,
 * Cloudflare, and any future one — must pass this unchanged (D-14). If an
 * adapter needs the suite modified, the contract changed and that is a
 * decision, not a patch.
 */
export function scopeHostContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture>,
  opts: ScopeHostSuiteOptions = {},
): void {
  const supportsRuntimeRegistration = opts.supportsRuntimeRegistration !== false;

  describe(`scope-host contract: ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    /** Tags the flaky executor successfully effected — the delivery evidence. */
    const effected: string[] = [];
    const t1 = tenantId.parse(ulid());
    const t2 = tenantId.parse(ulid());
    const t3 = tenantId.parse(ulid()); // control-plane §4.1 tenant-lifecycle fixture
    const t4 = tenantId.parse(ulid()); // §4.3 entitlement-gate fixture
    const t5 = tenantId.parse(ulid()); // §3.2/§4.5 directory-read fixture
    const s1 = scopeId.parse(ulid());
    const s2 = scopeId.parse(ulid());
    const s3 = scopeId.parse(ulid()); // scope under t3
    const s4 = scopeId.parse(ulid()); // scope under t4
    const alice: PrincipalId = principalId.parse(ulid());
    const staff = platformActorId.parse(ulid());

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;

      // Bare operations (no manifest) and the initial module set, registered in
      // the order the contract fixes (see contractTestInitialModules).
      for (const [name, handler] of Object.entries(contractTestBareOps)) {
        host.defineOperation(name, handler);
      }
      for (const reg of contractTestInitialModules) {
        host.registerModule(reg);
      }

      // The connector seam's out-of-band half (K-22 §4.2). Host code, not module
      // code: it holds platform authority, which is exactly what a module must
      // never have. Idempotent because delivery is at-least-once.
      host.registerExecutor('member-adder', 'member.add-requested', async (admin, event) => {
        const p = event.payload as { principal: string; orgId: string; tenantId: string };
        await admin.addMember(
          staff,
          p.tenantId as TenantId,
          p.principal as PrincipalId,
          p.orgId as OrgId,
        );
      });

      // #100 fixtures. `flaky` fails only for `poison*` tags and backs off far
      // enough that a retry cannot happen inside a test; `doomed` exhausts almost
      // immediately so the dead-letter path is reachable without waiting.
      host.registerExecutor(
        'flaky-effector',
        'effect.requested',
        async (_admin, event) => {
          const p = event.payload as { tag: string };
          if (p.tag.startsWith('poison')) throw new Error(`boom:${p.tag}`);
          effected.push(p.tag);
        },
        { maxAttempts: 5, baseDelayMs: 60_000 },
      );
      // The connector under test. maxAttempts 1 so a failure is terminal at once
      // and the dead-letter is observable without waiting.
      host.registerConnector(
        'outbound-caller',
        'outbound.requested',
        async (ctx, event) => {
          const p = event.payload as { tag: string };
          const conn = await ctx.connection('provider');
          const res = await conn.fetch('https://provider.test/v1/things', {
            method: 'POST',
            headers: { Authorization: `Bearer ${conn.secret.accessToken}` },
            body: JSON.stringify({ tag: p.tag }),
          });
          if (!res.ok) throw new Error(`provider said ${res.status}`);
        },
        { maxAttempts: 1 },
      );
      host.registerExecutor(
        'doomed-effector',
        'effect.doomed',
        async () => {
          throw new Error('always fails');
        },
        { maxAttempts: 2, baseDelayMs: 0 },
      );

      // A scope requires an existing active tenant (§4.1) — create then provision.
      await host.admin.createTenant(staff, { id: t1, slug: 'tenant-one', name: 'Tenant One' });
      await host.admin.createTenant(staff, { id: t2, slug: 'tenant-two', name: 'Tenant Two' });
      // Entitlements are default-deny (§4.3): t1 invokes these modules' operations,
      // so it must hold their SKU flags. (t2 only exercises bare, ungated ops.)
      for (const key of ['testmod', 'flow', 'guarded', 'victim', 'late', 'connector']) {
        await host.admin.grantEntitlement(staff, t1, key);
      }
      // t2 holds the connector SKU but connects nothing — "entitled but not
      // configured" is the state the no-connection test needs, and it is the
      // state every tenant is in the moment before an admin connects a provider.
      await host.admin.grantEntitlement(staff, t2, 'connector');
      // Bound to a vertical: a connection is keyed on (tenant, VERTICAL, provider),
      // so a scope with no vertical has no connection namespace at all.
      await host.provisionScope(staff, {
        tenantId: t1,
        scopeId: s1,
        jurisdiction: 'eu',
        vertical: 'connector-vertical',
      });
      await host.admin.activateScope(staff, t1, s1);
      await host.provisionScope(staff, {
        tenantId: t2,
        scopeId: s2,
        jurisdiction: 'eu',
        vertical: 'connector-vertical',
      });
      await host.admin.activateScope(staff, t2, s2);
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    it('provisioning is idempotent', async () => {
      await expect(
        host.provisionScope(staff, { tenantId: t1, scopeId: s1, jurisdiction: 'eu' }),
      ).resolves.toBeUndefined();
    });

    it('refuses to provision a scope under a tenant with no record (§4.1)', async () => {
      await expect(
        host.provisionScope(staff, {
          tenantId: tenantId.parse(ulid()),
          scopeId: scopeId.parse(ulid()),
        }),
      ).rejects.toThrow(/unknown tenant/);
    });

    it('fails closed on a mismatched (tenantId, scopeId) pair (K-3)', async () => {
      await expect(host.getScope(alice, t2, s1)).rejects.toThrow();
      await expect(host.getScope(alice, t1, scopeId.parse(ulid()))).rejects.toThrow();
    });

    it('serializes operations strictly per scope (K-6)', async () => {
      const stub = await host.getScope(alice, t1, s1);
      await stub.invoke('test/init-counter');
      await Promise.all(Array.from({ length: 10 }, () => stub.invoke('test/slow-increment')));
      await expect(stub.invoke('test/read-counter')).resolves.toBe(10);
    });

    it('clones inputs and results across the stub boundary (K-6)', async () => {
      const stub = await host.getScope(alice, t1, s1);
      const input = { items: ['a'] };
      await stub.invoke('test/stash', input);
      input.items.push('MUTATED-AFTER-CALL');
      const first = await stub.invoke<{ items: string[] }>('test/read-stash');
      expect(first.items).toEqual(['a']);
      first.items.push('MUTATED-RESULT');
      const second = await stub.invoke<{ items: string[] }>('test/read-stash');
      expect(second.items).toEqual(['a']);
    });

    it('stamps the event envelope kernel-side (§6.1)', async () => {
      const stub = await host.getScope(alice, t1, s1);
      await stub.invoke('test/emit-event');
      const rows = await stub.invoke<OutboxRow[]>('test/read-outbox');
      expect(rows.length).toBeGreaterThan(0);
      const row = rows[rows.length - 1]!;
      expect(row.tenant_id).toBe(t1);
      expect(row.scope_id).toBe(s1);
      expect(row.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(new Date(row.occurred_at).getTime()).not.toBeNaN();
      expect(row.pii_class).toBe('none');
    });

    it('rejects PII-classed events without a subjectId (§6.1)', async () => {
      const stub = await host.getScope(alice, t1, s1);
      await expect(stub.invoke('test/emit-unclassified-pii')).rejects.toThrow(/subjectId/);
    });

    it('accepts PII-classed events with a subjectId', async () => {
      const stub = await host.getScope(alice, t1, s1);
      await expect(stub.invoke('test/emit-event', { subject: ulid() })).resolves.toBeUndefined();
    });

    it('isolates scope storage: a write in one scope is invisible in another', async () => {
      const stub1 = await host.getScope(alice, t1, s1);
      const stub2 = await host.getScope(alice, t2, s2);
      await stub1.invoke('test/write-marker', { v: 'only-in-s1' });
      await expect(stub2.invoke('test/read-markers')).resolves.toEqual([]);
      await expect(stub1.invoke('test/read-markers')).resolves.toEqual(['only-in-s1']);
    });

    it('rejects unknown operations', async () => {
      const stub = await host.getScope(alice, t1, s1);
      await expect(stub.invoke('test/does-not-exist')).rejects.toThrow(/unknown operation/);
    });

    it('rolls back the entire operation when the handler throws (K-4)', async () => {
      const stub = await host.getScope(alice, t1, s1);
      await stub.invoke('test/atomic-init');
      await expect(stub.invoke('test/atomic-fail')).rejects.toThrow('boom');
      // Neither the write NOR its emitted event survive — one transaction.
      await expect(stub.invoke('test/atomic-read')).resolves.toEqual({ rows: 0, events: 0 });
    });

    it('applies module migrations lazily and journals them per (module, version)', async () => {
      const stub = await host.getScope(alice, t1, s1);
      const journal = await stub.invoke<{ module_id: string; version: string }[]>(
        'testmod/read-journal',
      );
      expect(journal).toContainEqual({ module_id: '@test/mod', version: '0001-init' });
      // Idempotent: another wake applies nothing twice.
      const again = await host.getScope(alice, t1, s1);
      const journal2 = await again.invoke<{ module_id: string; version: string }[]>(
        'testmod/read-journal',
      );
      expect(journal2.filter((r) => r.module_id === '@test/mod')).toHaveLength(1);
    });

    it.runIf(supportsRuntimeRegistration)(
      'applies migrations of modules registered after a scope was first accessed',
      async () => {
        host.registerModule(lateMod);
        const stub = await host.getScope(alice, t1, s1);
        await expect(stub.invoke('late/check')).resolves.toBe(1);
        const journal = await stub.invoke<{ module_id: string; version: string }[]>(
          'testmod/read-journal',
        );
        expect(journal).toContainEqual({ module_id: '@test/late', version: '0001-init' });
      },
    );

    // -- the connector seam (K-22 §4.2) --------------------------------------
    // A module asks, inside its transaction, for an effect it cannot perform:
    // membership is tenant-wide and lives in the directory, outside this scope's
    // serialization domain. A privileged executor effects it through HostAdmin.

    it('effects a module\'s request through an executor, and correlates the trail', async () => {
      const org = orgId.parse(ulid());
      const joiner = principalId.parse(ulid());
      await host.admin.createOrg(staff, { id: org, tenantId: t1, slug: 'seam', name: 'Seam' });

      const stub = await host.getScope(alice, t1, s1);
      await stub.invoke('connector/request-member', { principal: joiner, orgId: org });

      // Prompt dispatch: effected by the time the request returns, not on a timer.
      const members = await host.admin.listMembers(staff, t1, org);
      expect(members.map((m) => m.principal)).toEqual([joiner]);

      // The two halves join. The executor's admin row carries the id of the event
      // that caused it, which is what stops the split trail being unreadable —
      // control-plane.md §3 named that as the main cost of this pattern.
      const added = (await host.admin.auditLog(staff, { tenantId: t1 })).find(
        (e) => e.action === 'addMember' && JSON.stringify(e.after).includes(joiner),
      );
      expect(added?.causedBy).toEqual(expect.any(String));

      // A staff member acting directly caused nothing but themselves.
      const orgRow = (await host.admin.auditLog(staff, { tenantId: t1 })).find(
        (e) => e.action === 'createOrg',
      );
      expect(orgRow?.causedBy).toBeNull();
    });

    it('effects nothing when the emitting transaction rolls back', async () => {
      // The property the connector is chosen FOR. `ctx.emit` commits with the
      // domain write, so a rollback leaves no event and nothing to effect. An
      // in-scope cross-DO write could not offer this: it could land in the
      // directory and then be orphaned by the scope's rollback.
      const org = orgId.parse(ulid());
      const ghost = principalId.parse(ulid());
      await host.admin.createOrg(staff, { id: org, tenantId: t1, slug: 'ghost', name: 'Ghost' });

      const stub = await host.getScope(alice, t1, s1);
      await expect(
        stub.invoke('connector/request-and-throw', { principal: ghost, orgId: org }),
      ).rejects.toThrow(/deliberate failure/);

      expect(await host.admin.listMembers(staff, t1, org)).toEqual([]);
    });

    it('delivers each event to an executor exactly once', async () => {
      // At-least-once with a journal, so a second dispatch pass must not re-effect.
      // Membership is idempotent anyway; the audit trail is what would show a
      // double-run, and it must not.
      const org = orgId.parse(ulid());
      const once = principalId.parse(ulid());
      await host.admin.createOrg(staff, { id: org, tenantId: t1, slug: 'once', name: 'Once' });

      const stub = await host.getScope(alice, t1, s1);
      await stub.invoke('connector/request-member', { principal: once, orgId: org });
      // Another operation on the same scope drains the outbox again.
      await stub.invoke('connector/requests');

      const rows = (await host.admin.auditLog(staff, { tenantId: t1 })).filter(
        (e) => e.action === 'addMember' && JSON.stringify(e.after).includes(once),
      );
      expect(rows).toHaveLength(1);
    });

    // -- executor failure is contained (#100) ---------------------------------
    //
    // The seam's whole value is that an effect outside the scope cannot corrupt
    // the scope. Before this, a throwing executor escaped `invoke()` AFTER the
    // transaction committed — so the caller was told their work failed when it
    // had not, and the failing event re-ran on every later dispatch forever.

    it('a failing executor does not fail the operation that emitted the event', async () => {
      const stub = await host.getScope(alice, t1, s1);
      // The executor throws for `poison*`. The operation must still resolve: its
      // transaction committed, and the delivery is a separate fact. A rejection
      // here fails the test — which is exactly what the old behaviour did.
      await stub.invoke('connector/request-effect', { tag: 'poison-a' });

      // And it is now BACKED OFF, not hammering. Nothing else has work due at
      // this point in the suite, so an empty pass is a real statement about the
      // 60s backoff: the old code re-ran the failing effect on every dispatch.
      const report = await host.drainDue(t1, s1);
      expect(report.attempted).toBe(0);
      expect(report.deadLettered).toBe(0);
    });

    it('one poison delivery does not block the deliveries behind it', async () => {
      // `poison-a` from the previous test is failing and backed off. A later
      // event for the SAME executor must still be attempted — the old loop
      // stopped at the first throw and never reached it.
      const stub = await host.getScope(alice, t1, s1);
      await stub.invoke('connector/request-effect', { tag: 'ok-1' });
      expect(effected).toContain('ok-1');
      // The poison delivery is still pending, not dead — it is being retried,
      // not skipped, and it did not take `ok-1` down with it.
      expect(await host.executorDeadLetters(t1, s1)).toEqual([]);
    });

    it('exhausting attempts dead-letters the delivery, with the evidence kept', async () => {
      const stub = await host.getScope(alice, t1, s1);
      // maxAttempts: 2, baseDelayMs: 0 — attempt one on emit, attempt two on drain.
      await stub.invoke('connector/request-doomed', { tag: 'doomed-1' });
      const report = await host.drainDue(t1, s1);
      expect(report.deadLettered).toBe(1);

      const dead = await host.executorDeadLetters(t1, s1);
      const entry = dead.find((d) => d.executorId === 'doomed-effector');
      expect(entry).toBeDefined();
      expect(entry!.eventType).toBe('effect.doomed');
      expect(entry!.attempts).toBe(2);
      expect(entry!.error).toContain('always fails');
    });

    it('a dead-lettered delivery is terminal — it is not retried again', async () => {
      const before = await host.executorDeadLetters(t1, s1);
      const report = await host.drainDue(t1, s1);
      // Nothing new attempted for the doomed executor: the row is terminal.
      expect(report.deadLettered).toBe(0);
      const after = await host.executorDeadLetters(t1, s1);
      expect(after).toHaveLength(before.length);
    });

    // -- scope data introspection: the §5.4 admin-query RPC --------------------
    //
    // A read-only window into a scope's OWN database (the console/dashboard Data
    // view). The properties that matter: it sees the vertical's tables AND the
    // spine (flagged apart), pages, refuses an unknown table, and fails closed on
    // a mismatched (tenantId, scopeId) pair exactly as getScope does (K-3).

    describe('scope data introspection (§5.4)', () => {
      it('lists the scope tables, flagging the spine as system', async () => {
        const stub = await host.getScope(alice, t1, s1);
        await stub.invoke('test/write-marker', { v: 'introspect-me' });
        const tables = await host.admin.listScopeTables(staff, t1, s1);
        const byName = new Map(tables.map((t) => [t.name, t]));
        // The vertical's own table: present, not flagged system, with rows.
        expect(byName.get('marker')?.system).toBe(false);
        expect(byName.get('marker')!.rowCount).toBeGreaterThan(0);
        // The spine: present and flagged system, so the UI can group it apart.
        expect(byName.get('_substrat_outbox')?.system).toBe(true);
      });

      it('reads a bounded page of a table', async () => {
        const stub = await host.getScope(alice, t1, s1);
        await stub.invoke('test/write-marker', { v: 'page-row' });
        const page = await host.admin.readScopeTable(staff, t1, s1, { table: 'marker', limit: 50, offset: 0 });
        expect(page.columns).toContain('v');
        const vCol = page.columns.indexOf('v');
        expect(page.rows.map((r) => r[vCol])).toContain('page-row');
        expect(page.rowCount).toBeGreaterThanOrEqual(page.rows.length);
      });

      it('respects limit (paging)', async () => {
        const page = await host.admin.readScopeTable(staff, t1, s1, { table: 'marker', limit: 1, offset: 0 });
        expect(page.rows.length).toBeLessThanOrEqual(1);
        expect(page.limit).toBe(1);
      });

      it('rejects an unknown table', async () => {
        await expect(
          host.admin.readScopeTable(staff, t1, s1, { table: 'no_such_table', limit: 50, offset: 0 }),
        ).rejects.toThrow(/unknown table/);
      });

      it('fails closed on a mismatched (tenantId, scopeId) pair (K-3)', async () => {
        await expect(host.admin.listScopeTables(staff, t2, s1)).rejects.toThrow();
        await expect(
          host.admin.readScopeTable(staff, t2, s1, { table: 'marker', limit: 50, offset: 0 }),
        ).rejects.toThrow();
      });
    });

    // -- scope export (preview-and-snapshots.md §3) ---------------------------
    //
    // The privileged sibling of introspection: not a bounded page but the WHOLE
    // scope — every table, its DDL, every row — the source a fork/pull reads. What
    // matters: it is complete (the vertical's tables AND the spine), it is faithful
    // (rows + schema, not blob-as-null), it drops only the un-recreatable sqlite_*
    // internals, and it fails closed on a mismatched pair exactly as the reads do.

    describe('scope export (§3)', () => {
      it('dumps every table — the vertical\'s own AND the spine — with DDL and rows', async () => {
        const stub = await host.getScope(alice, t1, s1);
        await stub.invoke('test/write-marker', { v: 'export-me' });

        const dump = await host.admin.exportScope(staff, t1, s1);
        expect(dump.tenantId).toBe(t1);
        expect(dump.scopeId).toBe(s1);
        expect(dump.capturedAt).toBeTruthy();

        const byName = new Map(dump.tables.map((t) => [t.name, t]));
        // The vertical's own table: dumped, with its CREATE statement and its rows.
        const marker = byName.get('marker');
        expect(marker).toBeDefined();
        expect(marker!.ddl.toLowerCase()).toContain('create table');
        const vCol = marker!.columns.indexOf('v');
        expect(vCol).toBeGreaterThanOrEqual(0);
        expect(marker!.rows.map((r) => r[vCol])).toContain('export-me');
        // The `_substrat_*` spine is INCLUDED — a fork must carry event/migration state.
        expect(byName.has('_substrat_outbox')).toBe(true);
        expect(byName.has('_substrat_migrations')).toBe(true);
        // SQLite's own internals are NOT dumped (auto-managed, un-recreatable).
        expect(dump.tables.some((t) => t.name.startsWith('sqlite_'))).toBe(false);
      });

      it('is complete — every introspected table (minus sqlite internals) is present', async () => {
        const tables = await host.admin.listScopeTables(staff, t1, s1);
        const dump = await host.admin.exportScope(staff, t1, s1);
        const dumped = new Set(dump.tables.map((t) => t.name));
        for (const t of tables) {
          if (t.name.startsWith('sqlite_')) continue;
          expect(dumped.has(t.name)).toBe(true);
        }
        // The vertical table's rows are dumped in full (count matches introspection).
        const marker = dump.tables.find((t) => t.name === 'marker')!;
        const introMarker = tables.find((t) => t.name === 'marker')!;
        expect(marker.rows.length).toBe(introMarker.rowCount);
      });

      it('fails closed on a mismatched (tenantId, scopeId) pair (K-3)', async () => {
        await expect(host.admin.exportScope(staff, t2, s1)).rejects.toThrow();
      });
    });

    // -- scope import: the fork round-trip (preview-and-snapshots.md §3) -------
    //
    // The write side of exportScope. `importScope` provisions a NEW scope and loads
    // a dump into it — a faithful, INDEPENDENT copy at the source's frontier. What
    // matters: the copy has the source's tables + rows (fidelity), and the two do not
    // share storage (a later write to one is invisible to the other).

    describe('scope import — fork (§3)', () => {
      it('round-trips: import a dump into a new scope, identical to the source', async () => {
        const stub = await host.getScope(alice, t1, s1);
        await stub.invoke('test/write-marker', { v: 'fork-me' });
        const dump = await host.admin.exportScope(staff, t1, s1);

        const copy = scopeId.parse(ulid());
        await host.importScope(
          staff,
          { tenantId: t1, scopeId: copy, jurisdiction: 'eu', vertical: 'connector-vertical' },
          dump,
        );

        // Same tables and row counts as the source (the spine came across too).
        const src = (await host.admin.listScopeTables(staff, t1, s1))
          .map((t) => `${t.name}:${t.rowCount}`)
          .sort();
        const dst = (await host.admin.listScopeTables(staff, t1, copy))
          .map((t) => `${t.name}:${t.rowCount}`)
          .sort();
        expect(dst).toEqual(src);

        // The vertical's data is present in the copy.
        const page = await host.admin.readScopeTable(staff, t1, copy, {
          table: 'marker',
          limit: 200,
          offset: 0,
        });
        const vCol = page.columns.indexOf('v');
        expect(page.rows.map((r) => r[vCol])).toContain('fork-me');
      });

      it('is an independent copy — a later write to the source does not reach it', async () => {
        const dump = await host.admin.exportScope(staff, t1, s1);
        const copy = scopeId.parse(ulid());
        await host.importScope(
          staff,
          { tenantId: t1, scopeId: copy, jurisdiction: 'eu', vertical: 'connector-vertical' },
          dump,
        );
        const countMarker = async (sc: typeof copy) =>
          (await host.admin.listScopeTables(staff, t1, sc)).find((t) => t.name === 'marker')
            ?.rowCount ?? 0;
        const before = await countMarker(copy);

        // Write to the SOURCE after the fork; the copy is frozen at capture time.
        const stub = await host.getScope(alice, t1, s1);
        await stub.invoke('test/write-marker', { v: 'after-fork' });

        expect(await countMarker(copy)).toBe(before);
      });

      it('records fork provenance (forked_from/at + kind) on the new scope', async () => {
        const dump = await host.admin.exportScope(staff, t1, s1);
        const copy = scopeId.parse(ulid());
        await host.importScope(
          staff,
          {
            tenantId: t1,
            scopeId: copy,
            jurisdiction: 'eu',
            vertical: 'connector-vertical',
            kind: 'preview',
          },
          dump,
        );

        const rec = await host.admin.getScopeRecord(staff, t1, copy);
        expect(rec?.kind).toBe('preview');
        expect(rec?.forkedFrom).toBe(s1); // stamped from the dump's source scope
        expect(rec?.forkedAt).toBe(dump.capturedAt);

        // A normally-provisioned scope carries no provenance — the fields are what
        // set a fork apart.
        const src = await host.admin.getScopeRecord(staff, t1, s1);
        expect(src?.forkedFrom).toBeNull();
        expect(src?.forkedAt).toBeNull();
      });
    });

    // -- snapshot & auto-snapshot on bind (preview-and-snapshots.md §3/§4) -----
    //
    // snapshotScope forks an `archive` copy at the source's frontier. bindScopeVersion,
    // opted in, does it automatically before a MIGRATION-changing rebind — and only
    // then: a code-only rebind (same migration digest) snapshots nothing, and opting
    // out never snapshots.

    describe('scope snapshot (§3/§4)', () => {
      const countForks = async (of: typeof s1) =>
        (await host.admin.listScopes(staff, { tenantId: t1 })).filter((sc) => sc.forkedFrom === of)
          .length;

      it('snapshotScope forks an archive copy at the source frontier', async () => {
        const stub = await host.getScope(alice, t1, s1);
        await stub.invoke('test/write-marker', { v: 'snap-me' });

        const snapId = await host.snapshotScope(staff, t1, s1);
        const rec = await host.admin.getScopeRecord(staff, t1, snapId);
        expect(rec?.kind).toBe('archive');
        expect(rec?.forkedFrom).toBe(s1);

        const page = await host.admin.readScopeTable(staff, t1, snapId, {
          table: 'marker',
          limit: 200,
          offset: 0,
        });
        const vCol = page.columns.indexOf('v');
        expect(page.rows.map((r) => r[vCol])).toContain('snap-me');
      });

      it('bindScopeVersion snapshots a migration-changing rebind, and only that', async () => {
        // A fresh scope + a vertical with two admitted versions of differing migration
        // digest, plus a third that is a code-only change (same migration digest).
        const sb = scopeId.parse(ulid());
        await host.provisionScope(staff, {
          tenantId: t1,
          scopeId: sb,
          jurisdiction: 'eu',
          vertical: 'snaptest',
        });
        await host.admin.activateScope(staff, t1, sb);
        await host.admin.registerVertical(staff, {
          slug: 'snaptest',
          name: 'Snap Test',
          source: 'builtin',
        });
        const publish = async (version: string, mig: string) => {
          const id = ulid();
          await host.admin.publishVersion(staff, {
            id,
            verticalSlug: 'snaptest',
            version,
            manifestDigest: `man-${version}`,
            permissionDigest: 'p',
            migrationDigest: mig,
            deploymentRef: null,
          });
          await host.admin.admitVersion(staff, id);
          return id;
        };
        const vA = await publish('1.0.0', 'gA');
        const vB = await publish('2.0.0', 'gB'); // migration change vs vA
        const vBcode = await publish('2.0.1', 'gB'); // code-only vs vB

        const before = await countForks(sb);
        await host.admin.bindScopeVersion(staff, t1, sb, vA); // first bind — no prior version
        await host.admin.bindScopeVersion(staff, t1, sb, vB, { snapshot: true }); // gA→gB — snapshot
        expect(await countForks(sb)).toBe(before + 1);

        // The snapshot is an archive bound to the OUTGOING version (vA) — the frontier
        // it froze at.
        const forks = (await host.admin.listScopes(staff, { tenantId: t1 })).filter(
          (sc) => sc.forkedFrom === sb,
        );
        expect(forks.every((f) => f.kind === 'archive')).toBe(true);
        expect(forks.some((f) => f.verticalVersionId === vA)).toBe(true);

        // A code-only rebind (same migration digest), even opted in, snapshots nothing.
        await host.admin.bindScopeVersion(staff, t1, sb, vBcode, { snapshot: true });
        expect(await countForks(sb)).toBe(before + 1);

        // Opting out never snapshots, even across a migration boundary.
        await host.admin.bindScopeVersion(staff, t1, sb, vA); // gB→gA, no opts
        expect(await countForks(sb)).toBe(before + 1);
      });
    });

    // -- snapshot retention: deleteSnapshot + the GC sweep (§3/§9) -------------
    //
    // The one sanctioned hard delete, kept narrow: only a FORK may be reaped, and the
    // sweep only reaps forks whose creator asked for an expiry. What matters: the
    // delete removes record + hostnames + storage; a primary scope is refused; the
    // sweep takes exactly the expired and leaves the unexpired and the pinned.

    describe('snapshot retention (§3/§9)', () => {
      it('deleteSnapshot removes the fork — record, hostnames, and reachability', async () => {
        const snapId = await host.snapshotScope(staff, t1, s1);
        await host.admin.bindHostname(staff, {
          hostname: `snap-${snapId.toLowerCase()}.test.example`,
          tenantId: t1,
          scopeId: snapId,
          surface: 'app',
          region: null,
          canonical: true,
        });
        expect(await host.admin.listHostnames(staff, { scopeId: snapId })).toHaveLength(1);

        await host.deleteSnapshot(staff, t1, snapId);

        expect(await host.admin.getScopeRecord(staff, t1, snapId)).toBeUndefined();
        expect(await host.admin.listHostnames(staff, { scopeId: snapId })).toHaveLength(0);
        // The storage is unreachable through every read: the directory row is gone,
        // so the K-3 cross-check fails closed.
        await expect(host.admin.exportScope(staff, t1, snapId)).rejects.toThrow();
      });

      it('refuses to delete a primary scope (forkedFrom is null)', async () => {
        await expect(host.deleteSnapshot(staff, t1, s1)).rejects.toThrow(/not a fork/);
        // Still there, still readable.
        expect((await host.admin.getScopeRecord(staff, t1, s1))?.id).toBe(s1);
      });

      it('the GC sweep reaps exactly the expired forks', async () => {
        const past = new Date(Date.now() - 60_000).toISOString();
        const future = new Date(Date.now() + 3_600_000).toISOString();
        const expired = await host.snapshotScope(staff, t1, s1, { expiresAt: past });
        const unexpired = await host.snapshotScope(staff, t1, s1, { expiresAt: future });
        const pinned = await host.snapshotScope(staff, t1, s1); // no expiry — retained

        const report = await runPlatformSweep(host, {
          actor: staff,
          fetch: connectorTestFetch,
          sweepers: {},
          drainRetries: false,
        });

        expect(report.snapshotsReaped).toBeGreaterThanOrEqual(1);
        expect(await host.admin.getScopeRecord(staff, t1, expired)).toBeUndefined();
        expect((await host.admin.getScopeRecord(staff, t1, unexpired))?.id).toBe(unexpired);
        expect((await host.admin.getScopeRecord(staff, t1, pinned))?.id).toBe(pinned);
        // The primary scope was never in danger.
        expect((await host.admin.getScopeRecord(staff, t1, s1))?.id).toBe(s1);

        // Clean up the survivors so later suite state stays predictable.
        await host.deleteSnapshot(staff, t1, unexpired);
        await host.deleteSnapshot(staff, t1, pinned);
      });

      it('gcSnapshots: false skips the phase', async () => {
        const past = new Date(Date.now() - 60_000).toISOString();
        const snapId = await host.snapshotScope(staff, t1, s1, { expiresAt: past });
        const report = await runPlatformSweep(host, {
          actor: staff,
          fetch: connectorTestFetch,
          sweepers: {},
          drainRetries: false,
          gcSnapshots: false,
        });
        expect(report.snapshotsReaped).toBe(0);
        expect((await host.admin.getScopeRecord(staff, t1, snapId))?.id).toBe(snapId);
        await host.deleteSnapshot(staff, t1, snapId);
      });
    });

    // -- the integrations hub: connections (#101) -----------------------------
    //
    // The store exists so a vertical's connector can reach a tenant's provider
    // without any module ever holding a credential. So the properties that
    // matter are about what CANNOT be reached: not from a metadata read, not
    // from the audit log, not from another vertical, and not after a revoke.

    describe('connections', () => {
      const SECRET = { accessToken: 'tok-live-do-not-log', refreshToken: 'ref-abc' };

      it('round-trips a sealed credential for the vertical that owns it', async () => {
        const id = connectionId.parse(ulid());
        await host.admin.createConnection(staff, {
          id,
          tenantId: t1,
          vertical: 'callout',
          provider: 'scrive',
          label: 'Nordljus Scrive',
          scopes: ['doc:create', 'doc:send'],
          secret: SECRET,
        });
        const open = await host.admin.openConnection(t1, 'callout', 'scrive');
        expect(open?.secret).toEqual(SECRET);
        expect(open?.id).toBe(id);
      });

      it('never returns the credential from a metadata read', async () => {
        const rows = await host.admin.listConnections(staff, { tenantId: t1 });
        expect(rows).toHaveLength(1);
        expect(rows[0]!.provider).toBe('scrive');
        expect(rows[0]!.scopes).toEqual(['doc:create', 'doc:send']);
        // The strong form: the token does not appear ANYWHERE in the response.
        expect(JSON.stringify(rows)).not.toContain('tok-live-do-not-log');
      });

      it('never writes the credential into the append-only audit log', async () => {
        // This log can never be edited, so a secret written here would be
        // permanent. The redaction has to be structural, not remembered.
        const log = await host.admin.auditLog(staff, { tenantId: t1 });
        const created = log.filter((e) => e.action === 'createConnection');
        expect(created).toHaveLength(1);
        expect(JSON.stringify(log)).not.toContain('tok-live-do-not-log');
        expect(JSON.stringify(log)).not.toContain('ref-abc');
      });

      it('scopes a connection to its vertical — another vertical cannot open it', async () => {
        // D-30's blast-radius boundary, made real: verticals are built by
        // different companies (D-33), so one vendor's host code must not reach a
        // credential another vendor connected for the same tenant.
        expect(await host.admin.openConnection(t1, 'handlebar', 'scrive')).toBeUndefined();
        // …and the same tenant may connect the SAME provider for another vertical.
        await host.admin.createConnection(staff, {
          id: connectionId.parse(ulid()),
          tenantId: t1,
          vertical: 'handlebar',
          provider: 'scrive',
          label: 'Nordljus Scrive (bike shop)',
          secret: { accessToken: 'tok-other-vertical' },
        });
        const open = await host.admin.openConnection(t1, 'handlebar', 'scrive');
        expect(open?.secret).toEqual({ accessToken: 'tok-other-vertical' });
      });

      it('allows one live connection per (tenant, vertical, provider)', async () => {
        await expect(
          host.admin.createConnection(staff, {
            id: connectionId.parse(ulid()),
            tenantId: t1,
            vertical: 'callout',
            provider: 'scrive',
            label: 'a second one',
            secret: { accessToken: 'nope' },
          }),
        ).rejects.toThrow(/already has a live/);
      });

      it('rotates the credential without touching the connection identity', async () => {
        const [row] = await host.admin.listConnections(staff, {
          tenantId: t1,
          vertical: 'callout',
        });
        await host.admin.updateConnectionSecret(staff, row!.id, { accessToken: 'tok-refreshed' });
        const open = await host.admin.openConnection(t1, 'callout', 'scrive');
        expect(open?.id).toBe(row!.id); // same connection
        expect(open?.secret).toEqual({ accessToken: 'tok-refreshed' });
        const log = await host.admin.auditLog(staff, { tenantId: t1 });
        expect(log.some((e) => e.action === 'updateConnectionSecret')).toBe(true);
        expect(JSON.stringify(log)).not.toContain('tok-refreshed');
      });

      it('records health, and a success clears a prior error', async () => {
        const [row] = await host.admin.listConnections(staff, {
          tenantId: t1,
          vertical: 'callout',
        });
        await host.admin.recordConnectionUse(row!.id, { ok: false, error: 'HTTP 503 from provider' });
        let [after] = await host.admin.listConnections(staff, { tenantId: t1, vertical: 'callout' });
        expect(after!.status).toBe('error');
        expect(after!.lastError).toContain('503');

        await host.admin.recordConnectionUse(row!.id, { ok: true });
        [after] = await host.admin.listConnections(staff, { tenantId: t1, vertical: 'callout' });
        expect(after!.status).toBe('active');
        expect(after!.lastError).toBeNull();
        expect(after!.lastOkAt).not.toBeNull();
      });

      it('revoking destroys the credential but keeps the record as evidence', async () => {
        const [row] = await host.admin.listConnections(staff, {
          tenantId: t1,
          vertical: 'callout',
        });
        await host.admin.revokeConnection(staff, row!.id);

        // The credential is gone — not merely flagged.
        expect(await host.admin.openConnection(t1, 'callout', 'scrive')).toBeUndefined();
        // The row survives (K-21's tombstone rule): a grant that once existed is
        // evidence of why an access was allowed.
        expect(await host.admin.listConnections(staff, { tenantId: t1, vertical: 'callout' })).toEqual([]);
        const withRevoked = await host.admin.listConnections(staff, {
          tenantId: t1,
          vertical: 'callout',
          includeRevoked: true,
        });
        expect(withRevoked).toHaveLength(1);
        expect(withRevoked[0]!.status).toBe('revoked');
        expect(withRevoked[0]!.revokedAt).not.toBeNull();
      });

      it('lets a revoked connection be replaced — the uniqueness is over LIVE rows', async () => {
        await host.admin.createConnection(staff, {
          id: connectionId.parse(ulid()),
          tenantId: t1,
          vertical: 'callout',
          provider: 'scrive',
          label: 'reconnected',
          secret: { accessToken: 'tok-reconnected' },
        });
        const open = await host.admin.openConnection(t1, 'callout', 'scrive');
        expect(open?.secret).toEqual({ accessToken: 'tok-reconnected' });
      });

      it('isolates tenants: t2 sees nothing of t1', async () => {
        expect(await host.admin.listConnections(staff, { tenantId: t2 })).toEqual([]);
        expect(await host.admin.openConnection(t2, 'callout', 'scrive')).toBeUndefined();
      });
    });

    // -- connector state: a connector's own durable bookkeeping (#101 gap 3) ---

    describe('connector state', () => {
      it('round-trips arbitrary JSON keyed by (connection, key)', async () => {
        const id = connectionId.parse(ulid());
        await host.admin.createConnection(staff, {
          id,
          tenantId: t1,
          vertical: 'connector-vertical',
          provider: 'stateful',
          label: 'state test',
          secret: { accessToken: 'x' },
        });
        expect(await host.admin.getConnectorState(id, 'k')).toBeUndefined();
        await host.admin.putConnectorState(id, 'dispatch:inst-1', { documentId: 'doc-9', n: 2 });
        expect(await host.admin.getConnectorState(id, 'dispatch:inst-1')).toEqual({
          documentId: 'doc-9',
          n: 2,
        });
        // Upsert: a second put replaces.
        await host.admin.putConnectorState(id, 'dispatch:inst-1', { documentId: 'doc-9', n: 3 });
        expect(await host.admin.getConnectorState(id, 'dispatch:inst-1')).toEqual({
          documentId: 'doc-9',
          n: 3,
        });
      });

      it('enumerates state by prefix, ordered by key — the poll driver read', async () => {
        const id = connectionId.parse(ulid());
        await host.admin.createConnection(staff, {
          id,
          tenantId: t1,
          vertical: 'connector-vertical',
          provider: 'listable',
          label: 'list test',
          secret: { accessToken: 'x' },
        });
        // Two dispatch rows and one unrelated row under a different prefix.
        await host.admin.putConnectorState(id, 'dispatch:inst-b', { documentId: 'doc-b' });
        await host.admin.putConnectorState(id, 'dispatch:inst-a', { documentId: 'doc-a' });
        await host.admin.putConnectorState(id, 'cursor', { at: 'somewhere' });

        // Prefix narrows to the dispatch rows, ordered by key.
        expect(await host.admin.listConnectorState(id, 'dispatch:')).toEqual([
          { key: 'dispatch:inst-a', value: { documentId: 'doc-a' } },
          { key: 'dispatch:inst-b', value: { documentId: 'doc-b' } },
        ]);
        // No prefix returns everything the connection holds.
        expect((await host.admin.listConnectorState(id)).map((r) => r.key)).toEqual([
          'cursor',
          'dispatch:inst-a',
          'dispatch:inst-b',
        ]);
        // A prefix that matches nothing is empty, not an error.
        expect(await host.admin.listConnectorState(id, 'nope:')).toEqual([]);
        // Another connection's state is never returned.
        const other = connectionId.parse(ulid());
        expect(await host.admin.listConnectorState(other, 'dispatch:')).toEqual([]);
      });

      it('dies with the connection — revoke cascades', async () => {
        const id = connectionId.parse(ulid());
        await host.admin.createConnection(staff, {
          id,
          tenantId: t1,
          vertical: 'connector-vertical',
          provider: 'ephemeral',
          label: 'ephemeral',
          secret: { accessToken: 'x' },
        });
        await host.admin.putConnectorState(id, 'k', { v: 1 });
        await host.admin.revokeConnection(staff, id);
        // The bookkeeping is gone with the connection that owned it.
        expect(await host.admin.getConnectorState(id, 'k')).toBeUndefined();
      });
    });


    // -- connectors: credential + egress, bound to the scope's vertical -------

    describe('connectors', () => {
      beforeAll(async () => {
        resetConnectorCalls();
        // t1 connects the provider for the vertical its scope runs. t2 connects
        // nothing — that absence is a test.
        await host.admin.createConnection(staff, {
          id: connectionId.parse(ulid()),
          tenantId: t1,
          vertical: 'connector-vertical',
          provider: 'provider',
          label: 'provider for the connector suite',
          secret: { accessToken: 'tok-for-connector-vertical' },
        });
      });

      it('hands a connector the tenant credential and records health on egress', async () => {
        // The whole point of the seam: a connector reaches a provider without
        // any module ever holding a credential, and without importing a fetch.
        expect(connectorCalls).toEqual([]);
        const stub = await host.getScope(alice, t1, s1);
        await stub.invoke('connector/request-outbound', { tag: 'first' });

        expect(connectorCalls).toHaveLength(1);
        expect(connectorCalls[0]!.url).toBe('https://provider.test/v1/things');
        // The credential arrived, and it came from the vertical this scope runs.
        expect(connectorCalls[0]!.auth).toBe('Bearer tok-for-connector-vertical');

        // Egress recorded health against the connection it used.
        const [conn] = await host.admin.listConnections(staff, {
          tenantId: t1,
          provider: 'provider',
        });
        expect(conn!.lastOkAt).not.toBeNull();
      });

      it('records a failure on the connection when the provider errors', async () => {
        const stub = await host.getScope(alice, t1, s1);
        await stub.invoke('connector/request-outbound', { tag: 'fail-me' });
        const [conn] = await host.admin.listConnections(staff, {
          tenantId: t1,
          provider: 'provider',
        });
        expect(conn!.status).toBe('error');
        expect(conn!.lastError).toContain('503');
      });

      it('fails the delivery when the tenant has no connection for that provider', async () => {
        // t2 never connected anything. The connector must not silently no-op:
        // it retries and eventually dead-letters, which is visible.
        const stub2 = await host.getScope(alice, t2, s2);
        await stub2.invoke('connector/request-outbound', { tag: 'no-conn' });
        const dead = await host.executorDeadLetters(t2, s2);
        expect(dead.some((d) => /no live 'provider' connection/.test(d.error))).toBe(true);
      });
    });

    // -- vertical + version registry (#31) -----------------------------------
    // A scope binds to a VERSION, so dev/staging/prod are the same vertical pinned
    // differently. The invariant that earns the registry its keep is that a push
    // is not a deploy.

    it('publishes a version as pending, and refuses to bind it until admitted', async () => {
      const versionId = ulid();
      await host.admin.registerVertical(staff, {
        slug: 'callout',
        name: 'Callout',
        source: 'builtin',
      });
      await host.admin.publishVersion(staff, {
        id: versionId,
        verticalSlug: 'callout',
        version: '1.0.0',
        manifestDigest: 'm1',
        permissionDigest: 'p1',
        migrationDigest: 'g1',
        deploymentRef: null,
      });

      const [published] = await host.admin.listVersions(staff, 'callout');
      expect(published?.admission).toBe('pending');

      // The refusal the registry exists for. Without it "a push lands pending" is
      // a convention, and D-30's lockstep-upgrade argument is that conventions are
      // what we cannot afford here.
      await expect(host.admin.bindScopeVersion(staff, t1, s1, versionId)).rejects.toThrow(
        /pending, not admitted/,
      );

      await host.admin.admitVersion(staff, versionId);
      await host.admin.bindScopeVersion(staff, t1, s1, versionId);

      const scope = await host.admin.getScopeRecord(staff, t1, s1);
      expect(scope?.verticalVersionId).toBe(versionId);
      // The slug is denormalized alongside, so the console and the audit target
      // keep reading a label that survives the version being superseded.
      expect(scope?.vertical).toBe('callout');
    });

    it('records the owning tenant and fixes it at first push (claim-on-first-push)', async () => {
      // builder-plane.md Phase 1b: a vertical is owned by a TENANT (null = platform).
      // 'callout' above was registered platform-owned; a builder-pushed one carries
      // its pushing tenant, and that ownership is queryable off the registry row.
      // (The <tenant>/<name> slug prefix that keeps builder slugs globally unique is
      // constructed at push time in a later phase; ownership is the column here.)
      await host.admin.registerVertical(staff, {
        slug: 'helpdesk',
        name: 'Helpdesk',
        source: 'cli',
        ownerTenant: t2,
      });
      const listed = await host.admin.listVerticals(staff);
      expect(listed.find((v) => v.slug === 'callout')?.ownerTenant).toBeNull();
      expect(listed.find((v) => v.slug === 'helpdesk')?.ownerTenant).toBe(t2);

      // Idempotent when nothing changed — same push, same owner.
      await host.admin.registerVertical(staff, {
        slug: 'helpdesk',
        name: 'Helpdesk',
        source: 'cli',
        ownerTenant: t2,
      });

      // A slug's owner is fixed at first push: a different owner (or claiming a
      // platform vertical) is refused, naming both owners.
      await expect(
        host.admin.registerVertical(staff, {
          slug: 'helpdesk',
          name: 'Helpdesk',
          source: 'cli',
          ownerTenant: t1,
        }),
      ).rejects.toThrow(/owned by/);
      await expect(
        host.admin.registerVertical(staff, {
          slug: 'callout',
          name: 'Callout',
          source: 'builtin',
          ownerTenant: t2,
        }),
      ).rejects.toThrow(/owned by the platform/);
    });

    it('carries registry-driven install metadata (marketplace-publish.md §3) and refreshes it', async () => {
      // ownerGrants/entitlements/provides/requires ride the registry (one install_spec JSON
      // column) so the dashboard installs a vertical without a hardcoded catalog entry.
      await host.admin.registerVertical(staff, {
        slug: 'authy',
        name: 'Authy',
        source: 'cli',
        ownerTenant: t2,
        entitlements: ['authy'],
        ownerGrants: ['content:admin'],
        provides: ['oidc-issuer'],
      });
      const first = (await host.admin.listVerticals(staff)).find((v) => v.slug === 'authy');
      expect(first?.entitlements).toEqual(['authy']);
      expect(first?.ownerGrants).toEqual(['content:admin']);
      expect(first?.provides).toEqual(['oidc-issuer']);
      expect(first?.requires).toBeUndefined();

      // Like envSpec, install metadata evolves with the manifest: an otherwise-identical
      // re-registration refreshes it rather than conflicting.
      await host.admin.registerVertical(staff, {
        slug: 'authy',
        name: 'Authy',
        source: 'cli',
        ownerTenant: t2,
        entitlements: ['authy'],
        ownerGrants: ['content:admin', 'content:publish'],
        requires: ['oidc-issuer'],
      });
      const second = (await host.admin.listVerticals(staff)).find((v) => v.slug === 'authy');
      expect(second?.ownerGrants).toEqual(['content:admin', 'content:publish']);
      expect(second?.requires).toEqual(['oidc-issuer']);
      expect(second?.provides).toBeUndefined(); // dropped on refresh — the blob is replaced whole
    });

    it('publishes/unpublishes a vertical to the marketplace (setVerticalListed), preserved across re-push', async () => {
      const at = (slug: string) => host.admin.listVerticals(staff).then((vs) => vs.find((v) => v.slug === slug));
      await host.admin.registerVertical(staff, { slug: 'listtest', name: 'ListTest', source: 'cli', ownerTenant: t2 });
      expect((await at('listtest'))?.listed).toBe(false); // private on push

      await host.admin.setVerticalListed(staff, 'listtest', true);
      expect((await at('listtest'))?.listed).toBe(true); // published

      // The invariant: a re-push does NOT unpublish it — `listed` is its own column, untouched
      // by the register refresh (publish is a distinct action from push).
      await host.admin.registerVertical(staff, { slug: 'listtest', name: 'ListTest', source: 'cli', ownerTenant: t2 });
      expect((await at('listtest'))?.listed).toBe(true);

      await host.admin.setVerticalListed(staff, 'listtest', true); // idempotent
      await host.admin.setVerticalListed(staff, 'listtest', false);
      expect((await at('listtest'))?.listed).toBe(false); // unpublished

      // A builder's publish REQUEST is recorded, and RESOLVED (cleared) by the staff listing.
      await host.admin.requestPublish(staff, 'listtest');
      expect((await at('listtest'))?.publishRequestedAt).toBeTruthy();
      await host.admin.setVerticalListed(staff, 'listtest', true);
      expect((await at('listtest'))?.publishRequestedAt).toBeUndefined(); // cleared on review

      await expect(host.admin.setVerticalListed(staff, 'no-such-vertical', true)).rejects.toThrow(/unknown vertical/);
      await expect(host.admin.requestPublish(staff, 'no-such-vertical')).rejects.toThrow(/unknown vertical/);
    });

    it('refreshes `listed` on builtin re-registration (the catalog re-seed can list a row)', async () => {
      const at = (slug: string) => host.admin.listVerticals(staff).then((vs) => vs.find((v) => v.slug === slug));
      // A builtin first registered UNLISTED (bundled but not yet deployable, or a row
      // predating the `listed` column) must become listed when the seed says so —
      // `ensureCatalog` re-registers each boot, and for builtins `listed` is seed metadata.
      await host.admin.registerVertical(staff, { slug: 'seeded', name: 'Seeded', source: 'builtin' });
      expect((await at('seeded'))?.listed).toBe(false);

      await host.admin.registerVertical(staff, { slug: 'seeded', name: 'Seeded', source: 'builtin', listed: true });
      expect((await at('seeded'))?.listed).toBe(true);

      // And back: flipping the seed to `connected: false` delists on the next re-seed.
      await host.admin.registerVertical(staff, { slug: 'seeded', name: 'Seeded', source: 'builtin' });
      expect((await at('seeded'))?.listed).toBe(false);
    });

    it('refuses to bind a rejected version, and rejection is terminal', async () => {
      const versionId = ulid();
      await host.admin.publishVersion(staff, {
        id: versionId,
        verticalSlug: 'callout',
        version: '1.1.0-bad',
        manifestDigest: 'm2',
        permissionDigest: 'p2',
        migrationDigest: 'g2',
        deploymentRef: null,
      });
      await host.admin.rejectVersion(staff, versionId, 'permission diff widened a role');
      await expect(host.admin.bindScopeVersion(staff, t1, s1, versionId)).rejects.toThrow(
        /rejected, not admitted/,
      );
      // Terminal: a rejected version is not resurrected, a new one is published.
      await expect(host.admin.admitVersion(staff, versionId)).rejects.toThrow(/was rejected/);
      const rejected = (await host.admin.listVersions(staff, 'callout')).find(
        (v) => v.id === versionId,
      );
      expect(rejected?.admissionNote).toContain('widened a role');
    });

    it('carries the digests promotion compares', async () => {
      // "Has the permission surface changed between what is in prod and what I am
      // promoting?" is a string comparison here. Today it is a person remembering
      // to look, and a checkpoint that can be skipped is not a checkpoint.
      const versions = await host.admin.listVersions(staff, 'callout');
      for (const v of versions) {
        expect(v.manifestDigest).toEqual(expect.any(String));
        expect(v.permissionDigest).toEqual(expect.any(String));
        expect(v.migrationDigest).toEqual(expect.any(String));
      }
    });

    it('refuses a version for a vertical nobody registered', async () => {
      await expect(
        host.admin.publishVersion(staff, {
          id: ulid(),
          verticalSlug: 'ghost',
          version: '1.0.0',
          manifestDigest: 'm',
          permissionDigest: 'p',
          migrationDigest: 'g',
          deploymentRef: null,
        }),
      ).rejects.toThrow(/unknown vertical/);
    });

    // -- channels and promotion-time checkpoints (#31 step 2) ----------------
    // Promotion is the moment a change reaches anyone, so it is where §4's two
    // human checkpoints belong. Today they are a merge-time convention: CI renders
    // the diffs and a human is expected to look, but nothing ties that looking to
    // the moment of exposure.

    const publish = async (version: string, digests: { perm: string; mig: string }) => {
      const id = ulid();
      await host.admin.publishVersion(staff, {
        id,
        verticalSlug: 'callout',
        version,
        manifestDigest: `man-${version}`,
        permissionDigest: digests.perm,
        migrationDigest: digests.mig,
        deploymentRef: null,
      });
      await host.admin.admitVersion(staff, id);
      return id;
    };

    it('promotes a first version with nothing to acknowledge', async () => {
      // The gate is about CHANGE, not existence. A first promotion has no
      // predecessor to diff against, so demanding an acknowledgement would be
      // ceremony rather than review.
      const v1 = await publish('2.0.0', { perm: 'pA', mig: 'gA' });
      await host.admin.promoteVersion(staff, 'callout', 'prod', v1);
      const channels = await host.admin.listChannels(staff, 'callout');
      expect(channels.find((c) => c.channel === 'prod')?.versionId).toBe(v1);
    });

    it('refuses a promotion that changes permissions until it is acknowledged', async () => {
      const v2 = await publish('2.1.0', { perm: 'pB', mig: 'gA' }); // permissions moved
      await expect(host.admin.promoteVersion(staff, 'callout', 'prod', v2)).rejects.toThrow(
        /changes the permission surface/,
      );
      // Still pointing at the old one — a refused promotion changes nothing.
      const before = await host.admin.listChannels(staff, 'callout');
      expect(before.find((c) => c.channel === 'prod')?.versionId).not.toBe(v2);

      await host.admin.promoteVersion(staff, 'callout', 'prod', v2, { permissionChange: true });
      const after = await host.admin.listChannels(staff, 'callout');
      expect(after.find((c) => c.channel === 'prod')?.versionId).toBe(v2);
    });

    it('refuses a promotion that changes migrations until it is acknowledged', async () => {
      const v3 = await publish('2.2.0', { perm: 'pB', mig: 'gB' }); // migrations moved
      await expect(host.admin.promoteVersion(staff, 'callout', 'prod', v3)).rejects.toThrow(
        /changes migrations/,
      );
      await host.admin.promoteVersion(staff, 'callout', 'prod', v3, { migrationChange: true });
      expect(
        (await host.admin.listChannels(staff, 'callout')).find((c) => c.channel === 'prod')
          ?.versionId,
      ).toBe(v3);
    });

    it('records the acknowledgement, so review is evidence rather than a claim', async () => {
      const promotions = (await host.admin.auditLog(staff, {})).filter(
        (e) => e.action === 'promoteVersion',
      );
      const acknowledged = promotions.filter((e) =>
        JSON.stringify(e.after).includes('"permissionChange":true'),
      );
      // D-32's compliance product has to produce evidence that a control operated.
      // "Someone reviewed the permission change" is exactly such a control, and
      // this row is what makes it checkable after the fact.
      expect(acknowledged.length).toBeGreaterThan(0);
      expect(acknowledged[0]!.actor).toBe(staff);
    });

    it('promotes per channel — dev moving does not move prod', async () => {
      // The whole point of channels: the same vertical at different versions.
      const preview = await publish('2.3.0-preview', { perm: 'pC', mig: 'gC' });
      const prodBefore = (await host.admin.listChannels(staff, 'callout')).find(
        (c) => c.channel === 'prod',
      )?.versionId;
      await host.admin.promoteVersion(staff, 'callout', 'dev', preview);
      const channels = await host.admin.listChannels(staff, 'callout');
      expect(channels.find((c) => c.channel === 'dev')?.versionId).toBe(preview);
      expect(channels.find((c) => c.channel === 'prod')?.versionId).toBe(prodBefore);
    });

    it('refuses to promote a version that was never admitted', async () => {
      const pending = ulid();
      await host.admin.publishVersion(staff, {
        id: pending,
        verticalSlug: 'callout',
        version: '9.9.9',
        manifestDigest: 'm',
        permissionDigest: 'p',
        migrationDigest: 'g',
        deploymentRef: null,
      });
      await expect(host.admin.promoteVersion(staff, 'callout', 'dev', pending)).rejects.toThrow(
        /pending, not admitted/,
      );
    });

    // -- the provisioning state (K-31) ---------------------------------------

    it('provisions a scope as `provisioning`, not `active`', async () => {
      // The directory row exists before the vertical has created the scope DO. Born
      // active, it would promise something nothing has built yet.
      const t = tenantId.parse(ulid());
      const sc = scopeId.parse(ulid());
      await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
      await host.provisionScope(staff, { tenantId: t, scopeId: sc, jurisdiction: 'eu' });

      expect((await host.admin.getScopeRecord(staff, t, sc))?.status).toBe('provisioning');
    });

    it('refuses to open a scope that has not been activated', async () => {
      // The property the state exists for: a row nothing has confirmed is inert
      // rather than misleading.
      const t = tenantId.parse(ulid());
      const sc = scopeId.parse(ulid());
      await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
      await host.provisionScope(staff, { tenantId: t, scopeId: sc, jurisdiction: 'eu' });

      await expect(host.getScope(alice, t, sc)).rejects.toThrow(/not active/);

      await host.admin.activateScope(staff, t, sc);
      await expect(host.getScope(alice, t, sc)).resolves.toBeDefined();
    });

    it('is idempotent on an active scope, and refuses every other state', async () => {
      // Idempotent because provisioning is two-phase and the sweep re-runs it (K-31):
      // a retry of a finished instance must converge. Still a transition graph
      // though — reviving a suspended scope here would route around unsuspend.
      const t = tenantId.parse(ulid());
      const sc = scopeId.parse(ulid());
      await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
      await host.provisionScope(staff, { tenantId: t, scopeId: sc, jurisdiction: 'eu' });
      await host.admin.activateScope(staff, t, sc);

      await expect(host.admin.activateScope(staff, t, sc)).resolves.toBeUndefined();

      await host.admin.suspendScope(staff, t, sc);
      await expect(host.admin.activateScope(staff, t, sc)).rejects.toThrow();
    });

    it('audits the activation', async () => {
      const t = tenantId.parse(ulid());
      const sc = scopeId.parse(ulid());
      await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
      await host.provisionScope(staff, { tenantId: t, scopeId: sc, jurisdiction: 'eu' });
      await host.admin.activateScope(staff, t, sc);

      const entries = await host.admin.auditLog(staff, { scopeId: sc });
      expect(entries.map((e) => e.action)).toContain('activateScope');
    });

    // -- the hostname map (K-26) ---------------------------------------------
    // §4.2 provisions a scope; this is what finally gives it a URL. The router
    // resolves against these rows before dispatching to a vertical's worker.

    it('binds a hostname as pending, and resolves nothing until it is active', async () => {
      await host.admin.bindHostname(staff, {
        hostname: 'acme.example.com',
        tenantId: t1,
        scopeId: s1,
        surface: 'app',
        region: null,
        canonical: true,
      });
      // A custom domain is DNS validation and cert issuance, not a string somebody
      // sets — so it does not serve until those finish.
      expect(await host.admin.resolveHostname('acme.example.com')).toBeUndefined();

      await host.admin.setHostnameStatus(staff, 'acme.example.com', 'verifying');
      expect(await host.admin.resolveHostname('acme.example.com')).toBeUndefined();

      await host.admin.setHostnameStatus(staff, 'acme.example.com', 'active');
      expect(await host.admin.resolveHostname('acme.example.com')).toMatchObject({
        tenantId: t1,
        scopeId: s1,
        surface: 'app',
      });
    });

    it('routes two surfaces of ONE scope to different hostnames', async () => {
      // The reason §5.5's one-hostname-per-scope was not enough: the shop fronts a
      // storefront and a back office from the same data, and RallyPoint a player
      // app and a manager console.
      for (const [hostname, surface] of [
        ['shop.example.com', 'storefront'],
        ['admin.shop.example.com', 'back-office'],
      ]) {
        await host.admin.bindHostname(staff, {
          hostname: hostname!,
          tenantId: t1,
          scopeId: s1,
          surface: surface!,
          region: null,
          canonical: true,
        });
        await host.admin.setHostnameStatus(staff, hostname!, 'active');
      }
      expect((await host.admin.resolveHostname('shop.example.com'))?.surface).toBe('storefront');
      expect((await host.admin.resolveHostname('admin.shop.example.com'))?.surface).toBe(
        'back-office',
      );
    });

    it('keeps exactly one canonical hostname per surface', async () => {
      // "Which one do certs and redirects use" has to have one answer, so a new
      // canonical demotes the old rather than producing two.
      await host.admin.bindHostname(staff, {
        hostname: 'alias.example.com',
        tenantId: t1,
        scopeId: s1,
        surface: 'app',
        region: null,
        canonical: true,
      });
      const forApp = (await host.admin.listHostnames(staff, { scopeId: s1 })).filter(
        (h) => h.surface === 'app',
      );
      expect(forApp.filter((h) => h.canonical).map((h) => h.hostname)).toEqual([
        'alias.example.com',
      ]);
      // The demoted one is still bound — an alias, not a deletion.
      expect(forApp.map((h) => h.hostname)).toContain('acme.example.com');
    });

    it('treats hostname case as insignificant, because DNS does', async () => {
      // Otherwise two scopes could each hold "the same" name and a request would
      // resolve to whichever casing it arrived in.
      await host.admin.bindHostname(staff, {
        hostname: 'MiXeD.Example.COM',
        tenantId: t1,
        scopeId: s1,
        surface: 'app',
        region: null,
        canonical: false,
      });
      await host.admin.setHostnameStatus(staff, 'mixed.EXAMPLE.com', 'active');
      expect((await host.admin.resolveHostname('MIXED.example.com'))?.scopeId).toBe(s1);
      expect(
        (await host.admin.listHostnames(staff, { scopeId: s1 })).map((h) => h.hostname),
      ).toContain('mixed.example.com');
    });

    it('refuses to move a hostname to another scope', async () => {
      // A hostname routes to exactly one place. Silently rebinding would move
      // another tenant's traffic.
      await expect(
        host.admin.bindHostname(staff, {
          hostname: 'acme.example.com',
          tenantId: t2,
          scopeId: s2,
          surface: 'app',
          region: null,
          canonical: false,
        }),
      ).rejects.toThrow(/already bound to another scope/);
    });

    it('carries the region, which is what Regional Services is set from', async () => {
      // Residency is per hostname, which is why it lives here rather than in a
      // router deployed per jurisdiction (K-26).
      await host.admin.bindHostname(staff, {
        hostname: 'eu.example.com',
        tenantId: t1,
        scopeId: s1,
        surface: 'app',
        region: 'eu',
        canonical: false,
      });
      await host.admin.setHostnameStatus(staff, 'eu.example.com', 'active');
      expect((await host.admin.resolveHostname('eu.example.com'))?.region).toBe('eu');
    });

    it('records a failed hostname with the reason, rather than losing it', async () => {
      await host.admin.setHostnameStatus(staff, 'eu.example.com', 'failed', 'DNS validation timed out');
      const row = (await host.admin.listHostnames(staff, { scopeId: s1 })).find(
        (h) => h.hostname === 'eu.example.com',
      );
      expect(row?.status).toBe('failed');
      expect(row?.statusNote).toContain('DNS validation');
      // And it stops serving — "broken" and "not yet working" are different states,
      // but neither of them routes traffic.
      expect(await host.admin.resolveHostname('eu.example.com')).toBeUndefined();
    });

    it('unbinds a hostname: the row is gone, it stops resolving, and the unbind is audited', async () => {
      // The inverse of bindHostname — what a cleanup pass uses on orphaned rows.
      // A hard delete, not a tombstone: the row is routing config, and its history
      // lives in the admin log.
      await host.admin.unbindHostname(staff, 'EU.example.com'); // case-insensitive, like DNS
      expect(
        (await host.admin.listHostnames(staff, { scopeId: s1 })).map((h) => h.hostname),
      ).not.toContain('eu.example.com');
      expect(await host.admin.resolveHostname('eu.example.com')).toBeUndefined();

      const entries = await host.admin.auditLog(staff, { scopeId: s1 });
      expect(entries.map((e) => e.action)).toContain('unbindHostname');

      // Idempotent: unbinding an unknown hostname is a no-op, not an error — a
      // cleanup pass can re-run over a partial failure.
      await expect(host.admin.unbindHostname(staff, 'eu.example.com')).resolves.toBeUndefined();

      // The released name is immediately reclaimable by another scope.
      await host.admin.bindHostname(staff, {
        hostname: 'eu.example.com',
        tenantId: t2,
        scopeId: s2,
        surface: 'app',
        region: null,
        canonical: false,
      });
      const reclaimed = (await host.admin.listHostnames(staff, { scopeId: s2 })).find(
        (h) => h.hostname === 'eu.example.com',
      );
      expect(reclaimed?.scopeId).toBe(s2);
    });

    it('rejects duplicate module registration', () => {
      expect(() => host.registerModule({ manifest: testModManifest })).toThrow(/already registered/);
    });

    // -- manifest-declared operation guards (K-17) ---------------------------

    it('runs a manifest guard before the handler; a throw blocks and rolls back (K-17)', async () => {
      const stub = await host.getScope(alice, t1, s1);
      // Guard fails → the handler never ran: no row, and no event on the spine.
      await expect(stub.invoke('guarded/act', { flag: 'stop' })).rejects.toThrow(/expected flag/);
      await expect(stub.invoke<string[]>('guarded/rows')).resolves.toEqual([]);
      await expect(stub.invoke<number>('guarded/events')).resolves.toBe(0);

      // Guard passes → the handler runs, in the same transaction.
      await stub.invoke('guarded/act', { flag: 'go' });
      await expect(stub.invoke<string[]>('guarded/rows')).resolves.toEqual(['go']);
      await expect(stub.invoke<number>('guarded/events')).resolves.toBe(1);
    });

    it('fails closed when a declared guard names a predicate no module contributes', async () => {
      const stub = await host.getScope(alice, t1, s1);
      await expect(stub.invoke('guarded/orphan')).rejects.toThrow(/unknown guard predicate/);
    });

    it('rejects a predicate name already contributed by another module', () => {
      expect(() =>
        host.registerModule({
          manifest: moduleManifest.parse({
            ...gateModManifest,
            id: '@test/gate-clash',
            entitlementKey: 'gate-clash',
            permissions: [{ key: 'gateclash:use', description: 'clash' }],
          }),
          predicates: { 'gate/flag-set': () => undefined },
        }),
      ).toThrow(/already contributed/);
    });

    it('leaves unguarded operations untouched', async () => {
      const stub = await host.getScope(alice, t1, s1);
      await expect(stub.invoke<string[]>('guarded/rows')).resolves.toEqual(['go']);
    });

    // -- operation withdrawal (K-17) -----------------------------------------

    it('withdraws a default binding regardless of registration order (K-17)', async () => {
      const stub = await host.getScope(alice, t1, s1);
      // withdrawn BEFORE its module registered…
      await expect(stub.invoke('victim/a')).rejects.toThrow(/unknown operation/);
      // …and AFTER its module registered. Both are indistinguishable from an
      // operation that was never defined: fail closed, no special error class.
      await expect(stub.invoke('victim/b')).rejects.toThrow(/unknown operation/);
      // Withdrawal is per-operation and opt-in: everything else still binds.
      await expect(stub.invoke<string>('victim/c')).resolves.toBe('c');
    });

    it('rejects a module withdrawing its own operation', () => {
      expect(() =>
        host.registerModule({
          manifest: moduleManifest.parse({
            ...victimModManifest,
            id: '@test/self-withdrawer',
            entitlementKey: 'self-withdrawer',
            permissions: [{ key: 'selfw:use', description: 'self' }],
            withdraws: ['selfw/op'],
          }),
          operations: { 'selfw/op': (() => 'x') as OperationHandler<never, unknown> },
        }),
      ).toThrow(/withdraws its own operation/);
    });

    it('links declared entity relations, idempotently (K-16)', async () => {
      const stub = await host.getScope(alice, t1, s1);
      await stub.invoke('testmod/add', { id: 'i1', box: 'b1' });
      await stub.invoke('testmod/relink', { id: 'i1', box: 'b1' }); // no duplicate
      const tuples = await stub.invoke<{ subject: string; relation: string; object: string }[]>(
        'testmod/read-tuples',
      );
      expect(tuples.filter((t) => t.subject === 'item:i1')).toEqual([
        { subject: 'item:i1', relation: 'parent', object: 'box:b1' },
      ]);
    });

    it('rejects links for undeclared entity relations', async () => {
      const stub = await host.getScope(alice, t1, s1);
      await expect(stub.invoke('testmod/link-undeclared')).rejects.toThrow(
        /undeclared entity relation/,
      );
    });

    it('dispatches events to consumers, cascading, exactly once per (event, consumer)', async () => {
      const stub = await host.getScope(alice, t1, s1);
      await stub.invoke('flow/produce');
      const log = await stub.invoke<{ event_id: string; type: string }[]>('flow/log');
      expect(log.map((r) => r.type).sort()).toEqual(['flow.step1', 'flow.step2']);
      const deliveries = await stub.invoke<{ event_id: string; error: string | null }[]>(
        'flow/deliveries',
      );
      expect(deliveries).toHaveLength(2);
      expect(deliveries.every((d) => d.error === null)).toBe(true);

      await stub.invoke('flow/produce');
      const log2 = await stub.invoke<{ event_id: string; type: string }[]>('flow/log');
      expect(log2).toHaveLength(4); // two new, none duplicated
      await expect(stub.invoke('flow/deliveries')).resolves.toHaveLength(4);
    });

    it('runs consumers under a system actor — consumer-emitted events carry it', async () => {
      const stub = await host.getScope(alice, t1, s1);
      const actors = await stub.invoke<{ actor: string }[]>('flow/step2-actors');
      expect(actors.length).toBeGreaterThan(0);
      for (const row of actors) {
        expect(JSON.parse(row.actor)).toEqual({ system: '@test/flow' });
      }
    });

    // -- tenant registry + lifecycle (control-plane.md §4.1) -----------------

    it('creates a tenant record, idempotently; only real creates are audited', async () => {
      await host.admin.createTenant(staff, { id: t3, slug: 'acme-co', name: 'Acme Co' });
      await host.admin.createTenant(staff, { id: t3, slug: 'acme-co', name: 'Acme Co' }); // no-op
      expect(await host.admin.getTenant(staff, t3)).toMatchObject({
        id: t3,
        slug: 'acme-co',
        name: 'Acme Co',
        status: 'active',
      });
      expect((await host.admin.listTenants(staff)).filter((x) => x.id === t3)).toHaveLength(1);
      const creates = (await host.admin.auditLog(staff, { tenantId: t3 })).filter(
        (r) => r.action === 'createTenant',
      );
      expect(creates).toHaveLength(1); // the idempotent no-op left no row
      expect(creates[0]!.actor).toBe(staff);
    });

    it('suspends a tenant: getScope fails closed for its scopes; reactivation restores (§4.1)', async () => {
      await host.provisionScope(staff, { tenantId: t3, scopeId: s3, jurisdiction: 'eu' });
      await host.admin.activateScope(staff, t3, s3);
      await expect(host.getScope(alice, t3, s3)).resolves.toBeDefined();

      await host.admin.setTenantStatus(staff, t3, 'suspended');
      await expect(host.getScope(alice, t3, s3)).rejects.toThrow(/not active/);

      await host.admin.setTenantStatus(staff, t3, 'active');
      await expect(host.getScope(alice, t3, s3)).resolves.toBeDefined();
    });

    it('records setTenantStatus with before/after status', async () => {
      const transitions = (await host.admin.auditLog(staff, { tenantId: t3 })).filter(
        (r) => r.action === 'setTenantStatus',
      );
      expect(transitions.length).toBeGreaterThanOrEqual(2);
      const suspend = transitions.find(
        (r) => (r.after as { status: string }).status === 'suspended',
      )!;
      expect((suspend.before as { status: string }).status).toBe('active');
    });

    it('rejects a status transition on an unknown tenant', async () => {
      await expect(
        host.admin.setTenantStatus(staff, tenantId.parse(ulid()), 'suspended'),
      ).rejects.toThrow(/unknown tenant/);
    });

    // -- scope lifecycle (control-plane.md §4.2) ------------------------------

    it('suspend/unsuspend a scope gates getScope for that scope alone (§4.2)', async () => {
      // s3 is active (reactivated above). Suspending it fails closed…
      await host.admin.suspendScope(staff, t3, s3);
      await expect(host.getScope(alice, t3, s3)).rejects.toThrow(/scope not active/);
      // …while a sibling scope under the same tenant is untouched.
      const sibling = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t3, scopeId: sibling, jurisdiction: 'eu' });
      await host.admin.activateScope(staff, t3, sibling);
      await expect(host.getScope(alice, t3, sibling)).resolves.toBeDefined();
      // Unsuspend restores.
      await host.admin.unsuspendScope(staff, t3, s3);
      await expect(host.getScope(alice, t3, s3)).resolves.toBeDefined();
    });

    it('archive then un-archive is an explicit audited restore (§4.2)', async () => {
      await host.admin.archiveScope(staff, t3, s3);
      await expect(host.getScope(alice, t3, s3)).rejects.toThrow(/scope not active/);
      await host.admin.unarchiveScope(staff, t3, s3);
      await expect(host.getScope(alice, t3, s3)).resolves.toBeDefined();

      const transitions = (await host.admin.auditLog(staff, { tenantId: t3 })).filter(
        (r) => r.action === 'archiveScope' || r.action === 'unarchiveScope',
      );
      expect(transitions.map((r) => r.action)).toEqual(
        expect.arrayContaining(['archiveScope', 'unarchiveScope']),
      );
      for (const r of transitions) {
        expect(r.scopeId).toBe(s3);
        expect(r.actor).toBe(staff);
      }
    });

    it('rejects an illegal scope transition, fail closed (§4.2)', async () => {
      // s3 is active — you cannot un-archive an active scope.
      await expect(host.admin.unarchiveScope(staff, t3, s3)).rejects.toThrow(
        /illegal scope transition/,
      );
    });

    it('rejects a lifecycle transition on a scope not under the named tenant', async () => {
      await expect(host.admin.suspendScope(staff, t1, s3)).rejects.toThrow(
        /unknown scope for tenant/,
      );
    });

    // -- entitlement gate (control-plane.md §4.3) -----------------------------

    it('gates a module operation on the tenant holding its SKU flag (§4.3)', async () => {
      host.registerModule(billedMod);
      await host.admin.createTenant(staff, { id: t4, slug: 'billed-co', name: 'Billed Co' });
      await host.provisionScope(staff, { tenantId: t4, scopeId: s4, jurisdiction: 'eu' });
      await host.admin.activateScope(staff, t4, s4);
      const stub = await host.getScope(alice, t4, s4);

      // Default-deny: the flag is not held, so the operation does not resolve.
      await expect(stub.invoke('billed/act')).rejects.toThrow(/not entitled/);

      // Granting the flag loads the module for this tenant.
      await host.admin.grantEntitlement(staff, t4, 'billed');
      await expect(stub.invoke<string>('billed/act')).resolves.toBe('ran');
      expect(await host.admin.listEntitlements(staff, t4)).toContain('billed');

      // Revoking it takes the operation away again — as if never registered.
      await host.admin.revokeEntitlement(staff, t4, 'billed');
      await expect(stub.invoke('billed/act')).rejects.toThrow(/not entitled/);
      expect(await host.admin.listEntitlements(staff, t4)).not.toContain('billed');
    });

    it('audits grant/revoke idempotently and records the SKU flag', async () => {
      // Re-grant twice: only the first is a real change, so only one row.
      await host.admin.grantEntitlement(staff, t4, 'audited-sku');
      await host.admin.grantEntitlement(staff, t4, 'audited-sku');
      const grants = (await host.admin.auditLog(staff, { tenantId: t4 })).filter(
        (r) =>
          r.action === 'grantEntitlement' &&
          (r.after as { entitlementKey: string }).entitlementKey === 'audited-sku',
      );
      expect(grants).toHaveLength(1);
      expect(grants[0]!.actor).toBe(staff);

      await host.admin.revokeEntitlement(staff, t4, 'audited-sku');
      const revokes = (await host.admin.auditLog(staff, { tenantId: t4 })).filter(
        (r) => r.action === 'revokeEntitlement',
      );
      expect(revokes.length).toBeGreaterThanOrEqual(1);
      expect((revokes[revokes.length - 1]!.before as { entitlementKey: string }).entitlementKey).toBe(
        'audited-sku',
      );
    });

    it('leaves bare (module-less) operations ungated', async () => {
      // test/read-counter was registered via defineOperation, no manifest — it
      // must resolve regardless of entitlements.
      const stub = await host.getScope(alice, t1, s1);
      await expect(stub.invoke('test/read-counter')).resolves.toBeTypeOf('number');
    });

    // -- the scope directory, read side (control-plane.md §3.2/§4.5) ----------
    // §3.2 calls the directory the only complete inventory of tenants and scopes.
    // The write side was always complete; these pin the read side that makes the
    // claim true — and that the console is built on.

    it('defaults an unnamed scope to a slug derived from its id (§3.2)', async () => {
      await host.admin.createTenant(staff, { id: t5, slug: 'directory-co', name: 'Directory Co' });
      const bare = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t5, scopeId: bare });
      await host.admin.activateScope(staff, t5, bare);

      const rec = await host.admin.getScopeRecord(staff, t5, bare);
      // A ULID lowercases into a valid slug, so the placeholder is unique by
      // construction — every pre-existing caller provisions without naming.
      expect(rec).toMatchObject({
        id: bare,
        tenantId: t5,
        slug: bare.toLowerCase(),
        kind: 'scope',
        name: bare.toLowerCase(),
        vertical: null,
        parentScopeId: null,
        status: 'active',
        storageShape: 'A',
      });
    });

    it('round-trips the naming fields supplied at provisioning (§3.2)', async () => {
      const named = scopeId.parse(ulid());
      await host.provisionScope(staff, {
        tenantId: t5,
        scopeId: named,
        slug: 'brf-vasastan',
        kind: 'brf',
        name: 'Brf Vasastan',
        vertical: 'housing',
        jurisdiction: 'eu',
      });
      await host.admin.activateScope(staff, t5, named);
      expect(await host.admin.getScopeRecord(staff, t5, named)).toMatchObject({
        slug: 'brf-vasastan',
        kind: 'brf',
        name: 'Brf Vasastan',
        vertical: 'housing',
        jurisdiction: 'eu',
      });
    });

    it('refuses a slug already taken under the tenant, and re-provision is still idempotent (§3.2)', async () => {
      const other = scopeId.parse(ulid());
      await expect(
        host.provisionScope(staff, { tenantId: t5, scopeId: other, slug: 'brf-vasastan' }),
      ).rejects.toThrow(/already taken/);

      // Idempotency is keyed on the scope id, so re-provisioning the SAME scope
      // must not collide with its own slug.
      const named = (await host.admin.listScopes(staff, { tenantId: t5 })).find(
        (s) => s.slug === 'brf-vasastan',
      )!;
      await expect(
        host.provisionScope(staff, { tenantId: t5, scopeId: named.id, slug: 'brf-vasastan' }),
      ).resolves.toBeUndefined();
    });

    it('scopes slug uniqueness to the tenant, not the fleet (§3.2)', async () => {
      // The same slug under a different tenant is legitimate: the console's
      // handle is {tenant.slug}/{scope.slug}, which stays unique either way.
      const elsewhere = scopeId.parse(ulid());
      await expect(
        host.provisionScope(staff, { tenantId: t3, scopeId: elsewhere, slug: 'brf-vasastan' }),
      ).resolves.toBeUndefined();
    });

    it('refuses a tenant slug already taken, fail closed (§4.1)', async () => {
      // INSERT OR IGNORE would have reported this as an idempotent no-op and
      // silently not created the tenant the caller asked for.
      await expect(
        host.admin.createTenant(staff, {
          id: tenantId.parse(ulid()),
          slug: 'directory-co',
          name: 'Impostor Co',
        }),
      ).rejects.toThrow(/already taken/);
    });

    it('enumerates the scopes under a tenant, and filters by status (§4.5)', async () => {
      const all = await host.admin.listScopes(staff, { tenantId: t5 });
      expect(all.length).toBeGreaterThanOrEqual(2);
      expect(all.every((s) => s.tenantId === t5)).toBe(true);
      // Ordered by scope id — ULID order is chronological.
      expect(all.map((s) => s.id)).toEqual([...all.map((s) => s.id)].sort());

      const target = all[0]!;
      await host.admin.suspendScope(staff, t5, target.id);

      const suspended = await host.admin.listScopes(staff, { tenantId: t5, status: 'suspended' });
      expect(suspended.map((s) => s.id)).toEqual([target.id]);

      // Several statuses at once — the console's All / Suspended / Archived tabs.
      const both = await host.admin.listScopes(staff, {
        tenantId: t5,
        status: ['active', 'suspended'],
      });
      expect(both.length).toBe(all.length);

      // An empty status list means "no status is acceptable" — it must match
      // nothing, never degenerate into an unfiltered read of the whole fleet.
      expect(await host.admin.listScopes(staff, { tenantId: t5, status: [] })).toEqual([]);

      await host.admin.unsuspendScope(staff, t5, target.id);
    });

    it('lists the whole fleet across tenants when unfiltered (§4.5)', async () => {
      const fleet = await host.admin.listScopes(staff);
      const tenants = new Set(fleet.map((s) => s.tenantId));
      expect(tenants.size).toBeGreaterThan(1);
      expect(fleet.length).toBeGreaterThanOrEqual(
        (await host.admin.listScopes(staff, { tenantId: t5 })).length,
      );
    });

    it('filters the fleet by vertical (§4.5)', async () => {
      const housing = await host.admin.listScopes(staff, { vertical: 'housing' });
      expect(housing.length).toBeGreaterThanOrEqual(1);
      expect(housing.every((s) => s.vertical === 'housing')).toBe(true);
    });

    it('fails closed reading a scope record on a mismatched pair (K-3)', async () => {
      const [any] = await host.admin.listScopes(staff, { tenantId: t5 });
      // The scope exists — but not under t1. It must read as absent, never as
      // itself: the same rule getScope applies when minting a stub.
      expect(await host.admin.getScopeRecord(staff, t1, any!.id)).toBeUndefined();
      expect(await host.admin.getScopeRecord(staff, t5, scopeId.parse(ulid()))).toBeUndefined();
    });

    it('projects the applied-migration count into the directory (§5.4)', async () => {
      // schema_version shipped as a column and was written by nothing — always
      // '0'. Registered modules carry migrations, so a provisioned scope must
      // report a count, which is what makes "which scopes are behind" answerable
      // from the index without fanning out.
      const [any] = await host.admin.listScopes(staff, { tenantId: t5 });
      expect(Number(any!.schemaVersion)).toBeGreaterThan(0);
    });

    it('stamps the audit target with the scope vertical for lifecycle actions (§4.4)', async () => {
      // `vertical` was plumbed end-to-end and passed by no call site — every row
      // was null. A lifecycle action on a scope that names one must carry it.
      const named = (await host.admin.listScopes(staff, { tenantId: t5 })).find(
        (s) => s.vertical === 'housing',
      )!;
      await host.admin.suspendScope(staff, t5, named.id);
      const rows = (await host.admin.auditLog(staff, { tenantId: t5, scopeId: named.id })).filter(
        (r) => r.action === 'suspendScope',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.vertical).toBe('housing');
      await host.admin.unsuspendScope(staff, t5, named.id);
    });

    // -- the admin audit log, read side (control-plane.md §4.4/§4.5) ----------

    it('narrows the audit log by scope, actor and action (§4.5)', async () => {
      const [any] = await host.admin.listScopes(staff, { tenantId: t5 });

      const byScope = await host.admin.auditLog(staff, { tenantId: t5, scopeId: any!.id });
      expect(byScope.length).toBeGreaterThan(0);
      expect(byScope.every((r) => r.scopeId === any!.id)).toBe(true);

      const byActor = await host.admin.auditLog(staff, { tenantId: t5, actor: staff });
      expect(byActor.length).toBeGreaterThan(0);
      expect(byActor.every((r) => r.actor === staff)).toBe(true);
      // A different actor shares the log and must not see these rows.
      expect(await host.admin.auditLog(staff, { actor: platformActorId.parse(ulid()) })).toEqual([]);

      const lifecycle = await host.admin.auditLog(staff, {
        tenantId: t5,
        action: ['suspendScope', 'unsuspendScope'],
      });
      expect(lifecycle.length).toBeGreaterThan(0);
      expect(
        lifecycle.every((r) => r.action === 'suspendScope' || r.action === 'unsuspendScope'),
      ).toBe(true);

      // Single action, not an array — both spellings are accepted.
      const provisions = await host.admin.auditLog(staff, { tenantId: t5, action: 'provisionScope' });
      expect(provisions.every((r) => r.action === 'provisionScope')).toBe(true);

      // Empty action list matches nothing rather than everything.
      expect(await host.admin.auditLog(staff, { tenantId: t5, action: [] })).toEqual([]);
    });

    it('orders oldest-first by default and newest-first on request (§4.5)', async () => {
      const asc = await host.admin.auditLog(staff, { tenantId: t5 });
      const desc = await host.admin.auditLog(staff, { tenantId: t5, order: 'desc' });
      expect(asc.length).toBe(desc.length);
      expect(asc.length).toBeGreaterThan(1);
      // The default preserves the ordering the log shipped with; the console reads desc.
      expect(desc.map((r) => r.id)).toEqual([...asc.map((r) => r.id)].reverse());
    });

    it('limits and pages the audit log by cursor (§4.5)', async () => {
      const all = await host.admin.auditLog(staff, { tenantId: t5 });
      expect(all.length).toBeGreaterThan(2);

      const first = await host.admin.auditLog(staff, { tenantId: t5, limit: 2 });
      expect(first.map((r) => r.id)).toEqual(all.slice(0, 2).map((r) => r.id));

      // The cursor IS the last entry's id — ULID order is chronological, so no
      // separate encoding is needed. Paging forward resumes strictly after it.
      const next = await host.admin.auditLog(staff, {
        tenantId: t5,
        limit: 2,
        cursor: first[first.length - 1]!.id,
      });
      expect(next.map((r) => r.id)).toEqual(all.slice(2, 4).map((r) => r.id));

      // Descending pages backward from the cursor.
      const descPage = await host.admin.auditLog(staff, {
        tenantId: t5,
        order: 'desc',
        limit: 2,
        cursor: all[all.length - 1]!.id,
      });
      expect(descPage.map((r) => r.id)).toEqual(
        all
          .slice(-3, -1)
          .map((r) => r.id)
          .reverse(),
      );
    });

    it('bounds the audit log by time (§4.5)', async () => {
      const all = await host.admin.auditLog(staff, { tenantId: t5 });
      const pivot = all[1]!.at;
      // `since` is inclusive, `until` exclusive.
      const since = await host.admin.auditLog(staff, { tenantId: t5, since: pivot });
      expect(since.every((r) => r.at >= pivot)).toBe(true);
      expect(since.some((r) => r.id === all[1]!.id)).toBe(true);

      const until = await host.admin.auditLog(staff, { tenantId: t5, until: pivot });
      expect(until.every((r) => r.at < pivot)).toBe(true);
    });
  });
}
