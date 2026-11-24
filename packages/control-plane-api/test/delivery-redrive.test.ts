import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import { platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { createControlPlaneApi, DEV_ACTOR_HEADER, UNSAFE_devPlatformActorAuth, type VerticalClient } from '../src/index.js';

/**
 * #3365: staff re-drive a delivery that gave up. The scope's own deployment moves the row (only a
 * dead one), the admin log keeps who asked and whether it moved, and a moved delivery is routed and
 * the scope's drain asked for at once. The deployment's side is `adapter-cloudflare`'s
 * `connector-route.test.ts`; this is the route in front of it.
 */
describe('POST /tenants/:tenantId/scopes/:scopeId/redrive (#3365)', () => {
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const auth = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  const calls: string[] = [];
  const drains: string[] = [];
  /** Whether the deployment finds the named row dead, and so moves it. */
  let dead = true;
  const deployment = {
    retryPlatformRequest: async (_t: string, _s: string, id: string) => {
      calls.push(`retry-intent ${id}`);
      return { moved: dead };
    },
    retryExecutorDelivery: async (_t: string, _s: string, eventId: string, executorId: string) => {
      calls.push(`retry-delivery ${eventId} ${executorId}`);
      return { moved: dead };
    },
    routeDueDeliveries: async () => {
      calls.push('route-due');
      return { routed: 1, awaitingRoom: 0 };
    },
  } as unknown as VerticalClient;

  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;
  const redrive = (body: unknown) =>
    app.request(`/tenants/${t}/scopes/${s}/redrive`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
  const audited = async () => host.admin.auditLog(staff, { tenantId: t, scopeId: s, action: 'redriveDelivery' });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-delivery-redrive-'));
    host = new SqliteScopeHost({ dir });
    app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      resolveVertical: async () => deployment,
      onDeliveryRedriven: async (scope) => {
        drains.push(scope.scopeId);
      },
    });
    await host.admin.createTenant(staff, { id: t, slug: 'redrive-co', name: 'Redrive Co' });
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'acme/media' });
    await host.admin.activateScope(staff, t, s);
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a failed intent and a dead delivery each move, are audited, and ask for the drain — a delivery routed first', async () => {
    const intentId = ulid();
    const intent = await redrive({ intentId });
    expect(intent.status).toBe(200);
    expect(await intent.json()).toEqual({ moved: true });
    const delivery = await redrive({ eventId: 'event-1', executorId: 'acme.media:dam.file-received' });
    expect(await delivery.json()).toEqual({ moved: true });
    // Due again is not yet an intent: it is routed before the drain is asked for.
    expect(calls).toEqual([`retry-intent ${intentId}`, 'retry-delivery event-1 acme.media:dam.file-received', 'route-due']);
    expect(drains).toEqual([s, s]);
    expect((await audited()).map((r) => r.after)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ intentId, moved: true }),
        expect.objectContaining({ eventId: 'event-1', executorId: 'acme.media:dam.file-received', moved: true }),
      ]),
    );
  });

  it('a row that is not dead moves nothing and asks for no drain, still audited; a body naming neither is refused', async () => {
    dead = false;
    calls.length = 0;
    drains.length = 0;
    const before = (await audited()).length;
    expect(await (await redrive({ eventId: 'event-2', executorId: 'acme.media:dam.file-received' })).json()).toEqual({ moved: false });
    expect(calls).toEqual(['retry-delivery event-2 acme.media:dam.file-received']);
    expect(drains).toEqual([]);
    expect((await audited()).length).toBe(before + 1);
    for (const body of [{}, { intentId: 'x', eventId: 'y' }, { eventId: 'e' }, { intentId: 'not-an-id' }]) {
      expect((await redrive(body)).status, JSON.stringify(body)).toBe(400);
    }
  });
});
