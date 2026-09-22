import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { eventId, platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import {
  BOARD_VERTICAL,
  CRM_VERTICAL,
  boardImportMod,
  crmExportMod,
  verticalEventsContractSuite,
} from '@substrat-run/contract-tests';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { CloudflareScopeHost, type EventDrainDelegation } from '../src/host.js';
import { warmControlPlane } from './do-warmup.js';

// #1705 on workerd: the export read (the (type, id) seek and the recursive hop walk), the
// import journal and the watermark's compare-and-set are DO SQL here, run by real Durable
// Objects. Two deployments, one class each, over a directory of their own.
verticalEventsContractSuite('adapter-cloudflare (workerd)', async () => {
  await warmControlPlane(env.VE_CONTROL_PLANE);
  const secretBox = webCryptoSecretBox('test-key', new Uint8Array(32).fill(7));
  const producer = new CloudflareScopeHost({ scope: env.CRM_SCOPE, controlPlane: env.VE_CONTROL_PLANE, secretBox });
  producer.registerModule(crmExportMod);
  const consumer = new CloudflareScopeHost({ scope: env.BOARD_SCOPE, controlPlane: env.VE_CONTROL_PLANE, secretBox });
  consumer.registerModule(boardImportMod);
  return { producer, consumer, cleanup: async () => {} };
});

/**
 * #1705 on the SHARED control plane, which serves no scope's storage itself: every
 * cross-vertical verb refuses a scope bound to a vertical rather than answering from its own
 * module-less placeholder DO. Answering there is not a failure a caller would notice — the
 * read reports a hosted producer as having nothing to export, and a delivery journals a batch
 * into a scope that is not the one it names.
 *
 * `servesScopesElsewhere` is any delegation being set (#1706's own rule), so one delegation
 * that is never called stands the host up in that shape.
 */
describe('cross-vertical verbs on the shared control plane (#1705)', () => {
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const hosted = scopeId.parse(ulid());
  const ownScope = scopeId.parse(ulid());
  const wants = [{ type: 'crm.customer-created', schemaVersion: 1 }];
  const batch = (scope: typeof hosted) => ({
    source: { vertical: CRM_VERTICAL, scopeId: scopeId.parse(ulid()) },
    after: null,
    next: eventId.parse(ulid()),
    events: [],
    withheld: [],
  });
  const unreached: EventDrainDelegation = {
    readUndrained: async () => {
      throw new Error('the delegation is never called by these verbs');
    },
    markDrained: async () => {
      throw new Error('the delegation is never called by these verbs');
    },
    redrain: async () => {
      throw new Error('the delegation is never called by these verbs');
    },
  };
  let shared: CloudflareScopeHost;

  beforeAll(async () => {
    await warmControlPlane(env.VE_CONTROL_PLANE);
    const secretBox = webCryptoSecretBox('test-key', new Uint8Array(32).fill(7));
    // The shape of the shared control plane: a delegation set, and the consumer vertical's
    // modules registered so `importState` gets past its "this deployment imports nothing" answer.
    shared = new CloudflareScopeHost({
      scope: env.BOARD_SCOPE,
      controlPlane: env.VE_CONTROL_PLANE,
      secretBox,
      eventDrainDelegation: unreached,
    });
    shared.registerModule(boardImportMod);
    await shared.admin.createTenant(staff, { id: t, slug: `ve-cp-${t.toLowerCase()}`, name: 'Shared CP' });
    await shared.admin.grantEntitlement(staff, t, 'board-import');
    await shared.admin.grantEntitlement(staff, t, 'crm-export');
    // One scope served by a vertical's own deployment, and one this host serves itself.
    await shared.provisionScope(staff, { tenantId: t, scopeId: hosted, vertical: BOARD_VERTICAL });
    await shared.admin.activateScope(staff, t, hosted);
    await shared.provisionScope(staff, { tenantId: t, scopeId: ownScope });
    await shared.admin.activateScope(staff, t, ownScope);
  });

  it('refuses the producer read, the consumer state read and a delivery for a hosted scope', async () => {
    const served = `is served by the '${BOARD_VERTICAL}' deployment`;
    await expect(
      shared.admin.readExportedEvents(staff, t, hosted, { consumer: BOARD_VERTICAL, after: null, wants, limit: 10 }),
    ).rejects.toThrow(served);
    await expect(shared.admin.importState(staff, t, hosted)).rejects.toThrow(served);
    await expect(shared.deliverToPeer(t, hosted, batch(hosted))).rejects.toThrow(served);
  });

  it('answers for a scope it does serve — the refusal is about WHERE the storage is, not the verb', async () => {
    const read = await shared.admin.readExportedEvents(staff, t, ownScope, {
      consumer: BOARD_VERTICAL,
      after: null,
      wants,
      limit: 10,
    });
    expect(read).toMatchObject({ events: [], paused: null });
    expect((await shared.admin.importState(staff, t, ownScope)).consumes.length).toBeGreaterThan(0);
  });
});
