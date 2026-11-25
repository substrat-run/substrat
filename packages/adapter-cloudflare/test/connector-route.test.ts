import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  connectorDispatchPayload,
  permissionKey,
  principalId,
  scopeId,
  tenantId,
  isUndecodablePlatformRequest,
} from '@substrat-run/contracts';
import {
  CONNECTOR_DISPATCH_REQUESTED_BY,
  MAX_PENDING_CONNECTOR_DISPATCHES,
  intentPayloadCarriesSubject,
  ulid,
} from '@substrat-run/kernel';
import { CloudflareScopeHost } from './test-host.js';

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
    if (isUndecodablePlatformRequest(intent)) throw new Error(intent.decodeError);
    expect(intent.kind).toBe('connector:signer');
    expect(intent.requestedBy).toEqual({ system: 'connector-dispatch' });
    const payload = connectorDispatchPayload.parse(intent.payload);
    expect(payload.executorId).toBe('signer');
    expect(payload.event.type).toBe('perm.acted');
    expect(payload.event.tenantId).toBe(t);
    expect(payload.event.scopeId).toBe(s);
  });

  it('journals the routed delivery under the call that routed it (#1525)', async () => {
    // The hosted-dominant executor journal: every vertical is CP-less, so a connector
    // delivery is written here rather than by `recordExecutorAttempt`'s other caller.
    // The id crosses two hops to land — the coordinator names it, `drainExecutors`
    // carries it, and `routeExecutorEventToPlatform` writes it — so a drop anywhere on
    // that path would leave the common case reading "no call".
    const host = hostFor();
    const s2 = scopeId.parse(ulid());
    await host.provisionScopeLocal({
      tenantId: t,
      scopeId: s2,
      owner,
      roles: [{ key: 'office-admin', permissions: [USE], source: 'vertical' }],
      ownerRoleKey: 'office-admin',
    });
    const call = ulid();
    const scope = await host.getScope(owner, t, s2);
    await scope.invoke('perm/authorized-emit', { permission: USE }, { invocationId: call });

    const emitted = await host.invocationEventsLocal(s2, { invocationId: call });
    const acted = emitted.events.find((e) => e.type === 'perm.acted')!;
    expect(acted).toBeDefined();
    const tree = await host.eventEffectsLocal(s2, { eventId: acted.id });
    const delivery = tree.root!.deliveries.find((d) => d.consumer === 'executor:signer')!;
    expect(delivery).toBeDefined();
    expect(delivery.invocationId).toBe(call);
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
    if (!intent || isUndecodablePlatformRequest(intent)) throw new Error('expected one whole intent');
    await host.settlePlatformRequest(t, s, intent.id, {
      status: 'done',
      result: { eventId: 'routed' },
    });
    expect(await host.listPlatformRequests(t, s)).toHaveLength(0);
    expect((await host.drainDue(t, s)).attempted).toBe(0);
  });

  /**
   * #1600, the join: the payload this path REALLY writes is one the erasure selects.
   *
   * The redaction that `shredSubject` applies to the intent journal is decided by a
   * kernel predicate over the stored payload, and both adapters are held to it by the
   * shared contract suite — which builds the payload by hand, because the routing itself
   * exists only here. This is the other end of that: what `routeExecutorEventToPlatform`
   * actually stores when a CP-less host meets a PII-classed event. If the two ever part
   * company — a shape change on this side, a narrower predicate on that one — the suite
   * would stay green while a real name survived a real erasure.
   *
   * It cannot run the erasure itself: `shredSubject` is `HostAdmin`, and this host has no
   * control plane by construction — which is the very reason it routes at all.
   */
  it('writes a payload the subject erasure selects (#1600)', async () => {
    const s3 = scopeId.parse(ulid());
    const subject = ulid();
    const host = new CloudflareScopeHost({ scope: env.SCOPE });
    host.registerConnector('signer', 'test.happened', async () => undefined, {
      provider: 'signer',
    });
    await host.provisionScopeLocal({
      tenantId: t,
      scopeId: s3,
      owner,
      roles: [{ key: 'office-admin', permissions: [USE], source: 'vertical' }],
      ownerRoleKey: 'office-admin',
    });
    const scope = await host.getScope(owner, t, s3);
    await scope.invoke('test/emit-event', { subject, secret: 'anna-ek-was-here' });

    // The RAW stored TEXT, not the parsed contract shape: the redaction reads the column.
    const rows = await scope.invoke<{ id: string; kind: string; payload: string }[]>(
      'platform/read-requests',
    );
    const routed = rows.find((r) => r.kind === 'connector:signer')!;
    expect(routed).toBeDefined();
    // The defect, stated as a fact about this path rather than as a worry: the whole
    // event rides along, secret included.
    expect(routed.payload).toContain('anna-ek-was-here');
    expect(routed.payload).toContain(subject);
    // And the erasure can find it.
    expect(intentPayloadCarriesSubject(routed.payload, subject)).toBe(true);
    // A different subject's erasure must not select this row.
    expect(intentPayloadCarriesSubject(routed.payload, ulid())).toBe(false);
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

/**
 * #3365: a scope whose room for routed deliveries is full. A delivery that finds no room used to be
 * a failed attempt with backoff, so a backlog was dead-lettered in seconds under the default policy,
 * and nothing asked for the drain that would have made room. Now it is not an attempt: it stays
 * due, routing stops for the pass, the call still asks for a drain, and the first pass after one
 * routes it. The room is filled in one SQL batch rather than through 32 calls.
 */
describe('a full room for routed deliveries (#3365)', () => {
  const t = tenantId.parse(ulid());
  const owner = principalId.parse(ulid());
  const USE = permissionKey.parse('perm:use');
  const hostFor = () => {
    const host = new CloudflareScopeHost({ scope: env.SCOPE });
    host.registerConnector('signer', 'perm.acted', async () => undefined, { provider: 'signer' });
    return host;
  };
  /** A fresh scope whose routed-delivery room is full, and the ids of the rows that fill it. */
  const fullScope = async () => {
    const s = scopeId.parse(ulid());
    const inScope = <R>(fn: (sql: SqlStorage) => R) =>
      runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(s)), (_instance, state: DurableObjectState) => fn(state.storage.sql));
    await hostFor().provisionScopeLocal({
      tenantId: t,
      scopeId: s,
      owner,
      roles: [{ key: 'office-admin', permissions: [USE], source: 'vertical' }],
      ownerRoleKey: 'office-admin',
    });
    const planted = Array.from({ length: MAX_PENDING_CONNECTOR_DISPATCHES }, () => ulid());
    await inScope((sql) => {
      for (const id of planted) {
        sql.exec(
          `INSERT INTO _substrat_platform_requests (id, kind, payload, requested_by, impersonation, status, attempts, requested_at)
           VALUES (?, 'connector:signer', '{}', ?, NULL, 'pending', 0, ?)`,
          id,
          CONNECTOR_DISPATCH_REQUESTED_BY,
          new Date().toISOString(),
        );
      }
    });
    return { s, planted, inScope };
  };

  it('is not an attempt: the delivery stays due, routing stops at the first, and the call still asks for a drain', async () => {
    const { s, planted, inScope } = await fullScope();
    const host = hostFor();
    let kicks = 0;
    const scope = await host.getScope(owner, t, s, { onPlatformRequests: () => (kicks += 1) });
    await scope.invoke('perm/authorized-emit', { permission: USE });
    await scope.invoke('perm/authorized-emit', { permission: USE });
    // Each call found no room and asked for the drain that makes it.
    expect(kicks).toBe(2);

    // Two deliveries due; the pass stops at the first, and neither is journaled.
    expect(await host.drainDue(t, s)).toMatchObject({ attempted: 0, routedToPlatform: 0, awaitingRoom: 1, deadLettered: 0 });
    expect(
      await inScope((sql) => sql.exec(`SELECT 1 FROM _substrat_deliveries WHERE consumer_module = 'executor:signer'`).toArray().length),
    ).toBe(0);
    expect(await host.executorDeadLetters(t, s)).toEqual([]);
    // A routed delivery's room is its own: a sweep report still finds room beside a full one.
    const report = { version: null, entries: [{ kind: 'schedule' as const, operation: 'x/y', outcome: 'ok' as const, at: new Date().toISOString() }] };
    expect(await host.enqueueSweepRuns(s, report as never)).not.toBeNull();

    // A drain settles one; the refill routes one into its room, and the other keeps waiting.
    await host.settlePlatformRequest(t, s, planted[0] as never, { status: 'done', result: null });
    expect(await host.routeDueDeliveries(t, s)).toEqual({ routed: 1, awaitingRoom: 1 });
  });

  it('re-drives a delivery an older host dead-lettered on a full journal, and a failed connector intent', async () => {
    const { s, planted, inScope } = await fullScope();
    const host = hostFor();
    await (await host.getScope(owner, t, s)).invoke('perm/authorized-emit', { permission: USE });
    // The shape the old routing left behind: the room refusal counted until the policy gave up.
    const [waiting] = await inScope((sql) => sql.exec(`SELECT id FROM _substrat_outbox WHERE type = 'perm.acted'`).toArray().map((r) => String(r.id)));
    await inScope((sql) =>
      sql.exec(
        `INSERT INTO _substrat_deliveries (event_id, consumer_module, delivered_at, error, attempts, next_attempt_at)
         VALUES (?, 'executor:signer', ?, 'too many pending platform requests (32); the delivery retries once some have drained', 5, NULL)`,
        waiting!,
        new Date().toISOString(),
      ),
    );
    expect((await host.executorDeadLetters(t, s)).map((d) => d.eventId)).toEqual([waiting]);

    expect(await host.retryExecutorDeliveryLocal(t, s, waiting!, 'signer')).toBe(true);
    // Already due: a second re-drive moves nothing.
    expect(await host.retryExecutorDeliveryLocal(t, s, waiting!, 'signer')).toBe(false);
    expect(await host.executorDeadLetters(t, s)).toEqual([]);
    await host.settlePlatformRequest(t, s, planted[0] as never, { status: 'done', result: null });
    expect(await host.drainDue(t, s)).toMatchObject({ routedToPlatform: 1 });

    // A connector intent the drain gave up on goes back to pending with a fresh ceiling.
    await host.settlePlatformRequest(t, s, planted[1] as never, { status: 'failed', lastError: 'gave up after 100 drain attempts' });
    expect(await host.retryPlatformRequestLocal(t, s, planted[1] as never)).toBe(true);
    expect((await host.listPlatformRequests(t, s)).find((r) => r.id === planted[1])).toMatchObject({ status: 'pending', attempts: 0 });
    // Never another kind: re-running a provision or an archive is not a retry a journal row can justify.
    const other = ulid();
    await inScope((sql) =>
      sql.exec(
        `INSERT INTO _substrat_platform_requests (id, kind, payload, requested_by, impersonation, status, attempts, requested_at)
         VALUES (?, 'archive-scope', '{}', '"x"', NULL, 'failed', 3, ?)`,
        other,
        new Date().toISOString(),
      ),
    );
    expect(await host.retryPlatformRequestLocal(t, s, other as never)).toBe(false);
  });
});
