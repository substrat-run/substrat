import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  connectorDispatchPayload,
  permissionKey,
  principalId,
  scopeId,
  tenantId,
} from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { CloudflareScopeHost } from '../src/host.js';

/**
 * #574 phase 3, the vertical half: a CP-less host cannot run a connector (no
 * connection directory, no credentials, no sanctioned egress), so a connector
 * delivery must become a `connector:<provider>` platform intent — enqueued in the
 * scope's own spine table, journaled as routed in the same DO verb, and flagged
 * through `onPlatformRequests` so the harness can trigger the router kick. The
 * handler itself must never run here.
 */
describe('CP-less connector routing (#574 phase 3)', () => {
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const owner = principalId.parse(ulid());
  const USE = permissionKey.parse('perm:use');

  let handlerRan = 0;
  const hostFor = () => {
    // No `controlPlane` binding — the hosted-vertical shape.
    const host = new CloudflareScopeHost({ scope: env.SCOPE });
    host.registerConnector(
      'signer',
      'perm.acted',
      async () => {
        handlerRan += 1;
      },
      { provider: 'signer' },
    );
    return host;
  };

  beforeAll(async () => {
    await hostFor().provisionScopeLocal({
      tenantId: t,
      scopeId: s,
      owner,
      roles: [{ key: 'office-admin', permissions: [USE], source: 'vertical' }],
      ownerRoleKey: 'office-admin',
    });
  });

  it('routes the delivery as a connector:<provider> intent instead of running the handler', async () => {
    const host = hostFor();
    let flagged = 0;
    const scope = await host.getScope(owner, t, s, {
      onPlatformRequests: (n) => {
        flagged = n;
      },
    });
    await scope.invoke('perm/authorized-emit', { permission: USE });

    // The handler must not have run — this host has nothing to run it with.
    expect(handlerRan).toBe(0);
    // The inline drain routed the delivery and the harness was told, so the
    // response can carry the router-kick header.
    expect(flagged).toBe(1);

    const pending = await host.listPlatformRequests(t, s);
    expect(pending).toHaveLength(1);
    const intent = pending[0]!;
    expect(intent.kind).toBe('connector:signer');
    expect(intent.requestedBy).toEqual({ system: 'connector-dispatch' });
    const payload = connectorDispatchPayload.parse(intent.payload);
    expect(payload.executorId).toBe('signer');
    expect(payload.event.type).toBe('perm.acted');
    expect(payload.event.tenantId).toBe(t);
    expect(payload.event.scopeId).toBe(s);
  });

  it('journals the delivery as routed — a later drain must not route it again', async () => {
    const host = hostFor();
    const report = await host.drainDue(t, s);
    expect(report.attempted).toBe(0);
    expect(report.routedToPlatform).toBe(0);
    expect(await host.listPlatformRequests(t, s)).toHaveLength(1);
  });

  it('a settled intent leaves the pending surface and the delivery stays terminal', async () => {
    const host = hostFor();
    const [intent] = await host.listPlatformRequests(t, s);
    await host.settlePlatformRequest(t, s, intent!.id, {
      status: 'done',
      result: { eventId: 'routed' },
    });
    expect(await host.listPlatformRequests(t, s)).toHaveLength(0);
    expect((await host.drainDue(t, s)).attempted).toBe(0);
  });

  it('dispatchConnector fails closed on a CP-less host — routing exists because running cannot', async () => {
    const host = hostFor();
    const event = {
      id: ulid(),
      type: 'perm.acted',
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      tenantId: t,
      scopeId: s,
      actor: { system: 'connector-dispatch' },
      entity: { entityType: 'test-thing', entityId: 'x1' },
      piiClass: 'none',
      payload: {},
    };
    await expect(
      host.dispatchConnector(t, s, async () => undefined, event as never),
    ).rejects.toThrow(/control plane unavailable/);
  });
});
