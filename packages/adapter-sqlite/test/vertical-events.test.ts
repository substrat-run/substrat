import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { BOARD_VERTICAL, CRM_VERTICAL, boardImportMod, crmExportMod, verticalEventsContractSuite } from '@substrat-run/contract-tests';
import { permissionKey, platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { runPlatformSweep, ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

// Two deployments over ONE directory (#1705): the producer vertical's host and the consumer
// vertical's host, each registering only its own module, as a platform with one deployment
// per vertical runs them. The default tuple checker on both, because the suite's authority
// claims are about real grants.
verticalEventsContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-vertical-events-'));
  const producer = new SqliteScopeHost({ dir });
  producer.registerModule(crmExportMod);
  const consumer = new SqliteScopeHost({ dir });
  consumer.registerModule(boardImportMod);
  return {
    producer,
    consumer,
    cleanup: async () => {
      await producer.close();
      await consumer.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

/**
 * #1705 PR 3: a replay's archive, clear and watermark are ONE transaction. A failure injected at
 * the last statement (a trigger refusing the watermark's delete) must leave the journal, the
 * deliveries and the watermark exactly as they were, and nothing in `_substrat_import_replays`.
 * The positive twin: with the trigger gone, the same replay moves.
 */
describe('adapter-sqlite: the replay is atomic (#1705 PR 3)', () => {
  it('a failure mid-move leaves nothing half-moved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'substrat-replay-atomic-'));
    const host = new SqliteScopeHost({ dir });
    try {
      host.registerModule(crmExportMod);
      host.registerModule(boardImportMod);
      const staff = platformActorId.parse(ulid());
      const writer = principalId.parse(ulid());
      const t = tenantId.parse(ulid());
      await host.admin.createTenant(staff, { id: t, slug: 'atomic', name: 'Atomic' });
      await host.admin.grantEntitlement(staff, t, 'crm-export');
      await host.admin.grantEntitlement(staff, t, 'board-import');
      const install = async (vertical: string) => {
        const s = scopeId.parse(ulid());
        await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical });
        await host.admin.activateScope(staff, t, s);
        return s;
      };
      const p = await install(CRM_VERTICAL);
      const c = await install(BOARD_VERTICAL);
      await host.admin.grant(staff, { principalId: writer, permission: permissionKey.parse('customer:write'), node: { tenantId: t, scopeId: p }, grantedBy: writer });
      await (await host.getScope(writer, t, p)).invoke('crm/create', { name: 'Kept' });
      await runPlatformSweep(host, {
        actor: staff,
        fetch: async () => new Response('unused'),
        sweepers: {},
        drainRetries: false,
        gcSnapshots: false,
        reconcileMigrations: false,
        runSchedules: false,
        crossVertical: {},
      });
      const file = new Database(join(dir, `${t}__${c}.sqlite`));
      const snapshot = () => ({
        imports: file.prepare('SELECT event_id FROM _substrat_imports ORDER BY event_id').all(),
        deliveries: file.prepare('SELECT event_id, consumer_module FROM _substrat_deliveries ORDER BY event_id').all(),
        cursors: file.prepare('SELECT source_scope_id, cursor FROM _substrat_import_cursors').all(),
        replays: file.prepare('SELECT COUNT(*) AS n FROM _substrat_import_replays').get(),
      });
      const before = snapshot();
      expect(before.imports).toHaveLength(1);
      file.exec(`CREATE TRIGGER injected BEFORE DELETE ON _substrat_import_cursors BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`);
      const move = { mode: 'replay', from: CRM_VERTICAL, after: null, acknowledge: 'rerun-handlers', reason: 'atomicity' } as const;
      await expect(host.admin.moveImportCursor(staff, t, c, move)).rejects.toThrow(/injected failure/);
      expect(snapshot()).toEqual(before);
      // The twin: the same replay, unobstructed, moves all of it.
      file.exec('DROP TRIGGER injected');
      await expect(host.admin.moveImportCursor(staff, t, c, move)).resolves.toMatchObject({ archived: { journal: 1, deliveries: 1 } });
      expect(snapshot()).toMatchObject({ imports: [], deliveries: [], cursors: [], replays: { n: 2 } });
      file.close();
    } finally {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
