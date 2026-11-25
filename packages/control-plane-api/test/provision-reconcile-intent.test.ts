/**
 * K-69 (rfc/tenant-scale.md §7.5): the control plane's half of the on-wake provision reconcile. The
 * scope's half (which wakes ask) is adapter-cloudflare/test/reconcile-on-wake.test.ts; this is what
 * the drain does with an ask, over a fake directory and a fake reach.
 */
import { describe, expect, it } from 'vitest';
import {
  PROVISION_RECONCILE_KIND,
  instant,
  platformActorId,
  platformRequestId,
  scopeId,
  tenantId,
  type PlatformRequest,
  type Scope,
} from '@substrat-run/contracts';
import { ulid, type ReconcileOutcome } from '@substrat-run/kernel';
import { drainScopePlatformRequests, type PlatformDrainContext } from '../src/platform-drain.js';
import { provisionReconcileHandler, reconcileOnWakeEnabled } from '../src/provision-reconcile-intent.js';

const T = tenantId.parse(ulid());
const S = scopeId.parse(ulid());
const ACTOR = platformActorId.parse(ulid());
const ctx: PlatformDrainContext = {
  tenantId: T,
  scopeId: S,
  vertical: 'acme',
  scope: { kind: 'primary', forkedFrom: null },
  lifecycle: { scope: 'active', tenant: 'active' },
};
const ask = (): PlatformRequest => ({
  id: platformRequestId.parse(ulid()),
  kind: PROVISION_RECONCILE_KIND,
  payload: { wokeOn: 'v4' },
  requestedBy: { system: 'reconcile-on-wake' },
  impersonation: null,
  status: 'pending',
  attempts: 0,
  lastError: null,
  failure: null,
  result: null,
  requestedAt: instant.parse(new Date().toISOString()),
  settledAt: null,
});

/** An install idle since v1, now running v4 on the stable script, and the calls the handler made. */
function world(over: Partial<Scope> = {}, reach: (target: string) => Promise<'unsupported' | ReconcileOutcome> = async () => ({ retirementsFinished: true })) {
  const calls: string[] = [];
  const rec = {
    id: S,
    tenantId: T,
    vertical: 'acme',
    status: 'active',
    kind: 'primary',
    forkedFrom: null,
    verticalVersionId: 'v1',
    servingRef: 'acme-live',
    provisionedVersionId: 'v1',
    retirementsFinishedVersionId: 'v1',
    boundShapes: { versionId: 'v1', types: [] },
    ...over,
  } as unknown as Scope;
  const handler = (enabled = true) =>
    provisionReconcileHandler({
      actor: ACTOR,
      enabled,
      admin: {
        getScopeRecord: async () => (calls.push('read'), rec),
        verticalServing: async () => ({ ref: 'acme-live', versionId: 'v4', doClasses: [], migrationTag: 't' }),
        markScopeProvisioned: async (_a, _t, _s, version, outcome) => {
          calls.push(`mark ${version} ${JSON.stringify(outcome)}`);
        },
      },
      reconcile: async (_t, _s, target) => (calls.push(`reconcile ${target}`), reach(target)),
    });
  return { calls, handler };
}

describe('the provision-reconcile intent handler (K-69)', () => {
  it('reconciles an install that slept through several promotes against the version it runs, and writes that receipt', async () => {
    const { calls, handler } = world();
    await expect(handler()(ctx, ask())).resolves.toEqual({ status: 'done', result: { outcome: 'reconciled', versionId: 'v4' } });
    expect(calls).toEqual(['read', 'reconcile v4', 'mark v4 {"retirementsFinished":true}']);
  });

  it('runs nothing for an install already reconciled, a copy, a 501 (no receipt), or with the switch off', async () => {
    const current = world({ provisionedVersionId: 'v4', retirementsFinishedVersionId: 'v4', boundShapes: { versionId: 'v4', types: [] } });
    await expect(current.handler()(ctx, ask())).resolves.toEqual({ status: 'done', result: { outcome: 'up-to-date', versionId: 'v4' } });
    expect(current.calls).toEqual(['read']);

    const copy = world({ kind: 'preview' });
    await expect(copy.handler()(ctx, ask())).resolves.toMatchObject({ result: { outcome: 'not-an-install' } });
    expect(copy.calls).toEqual(['read']);

    const unsupported = world({}, async () => 'unsupported');
    await expect(unsupported.handler()(ctx, ask())).resolves.toEqual({ status: 'done', result: { outcome: 'unsupported', versionId: 'v4' } });
    expect(unsupported.calls).toEqual(['read', 'reconcile v4']);

    const off = world();
    await expect(off.handler(false)(ctx, ask())).resolves.toEqual({ status: 'done', result: { outcome: 'switched-off' } });
    expect(off.calls).toEqual([]);
    expect([undefined, '', 'on', 'yes'].map(reconcileOnWakeEnabled)).toEqual([true, true, true, true]);
    expect(['off', ' OFF ', '0', 'false'].map(reconcileOnWakeEnabled)).toEqual([false, false, false, false]);
  });

  it('a refused reconcile writes no receipt and leaves the ask pending, so the next drain retries it', async () => {
    const { calls, handler } = world({}, async () => {
      throw new Error('the deployment answered 503');
    });
    const settled: unknown[] = [];
    const report = await drainScopePlatformRequests(
      {
        listPlatformRequests: async () => [ask()],
        settlePlatformRequest: async (_t, _s, _id, body) => void settled.push(body),
      },
      ctx,
      { [PROVISION_RECONCILE_KIND]: handler() },
    );
    expect(report).toMatchObject({ pending: 1, done: 0, failed: 0 });
    expect(settled).toEqual([expect.objectContaining({ status: 'pending', lastError: 'the deployment answered 503' })]);
    expect(calls).toEqual(['read', 'reconcile v4']);
  });
});
