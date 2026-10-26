import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  PEER_INVOKE_KIND,
  platformActorId,
  platformRequestId,
  principalId,
  scopeId,
  tenantId,
  type PlatformRequest,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import {
  ControlPlaneError,
  drainScopePlatformRequests,
  peerInvokeHandler,
  provisionTenantHandler,
  setEntitlementsHandler,
  type PlatformRequestHandler,
  type VerticalClient,
} from '@substrat-run/control-plane-api';
import { CloudflareScopeHost } from './test-host.js';
import { warmControlPlane } from './do-warmup.js';

beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

/**
 * #2556 on workerd, where the platform drain runs: the settle journals a fixed sentence and the
 * platform's reference for the three handlers whose text comes from beyond the drained scope
 * (peer-invoke, provision-tenant, set-entitlements), and staff read the text under that reference
 * in the directory DO. The SQLite twin is `control-plane-api/test/intent-journal-text.test.ts`.
 */
describe('the journal withholds text from beyond the drained scope (#2556)', () => {
  const staff = platformActorId.parse(ulid());
  const mine = tenantId.parse(ulid());
  const stranger = tenantId.parse(ulid());
  const customer = tenantId.parse(ulid());
  const caller = scopeId.parse(ulid());
  const target = scopeId.parse(ulid());
  const manager = scopeId.parse(ulid());
  const authScope = scopeId.parse(ulid());
  const owner = principalId.parse(ulid());
  // The directory DO is shared with every other file, so every name here is this run's own.
  const managerVertical = `manager-${ulid().toLowerCase()}`;
  const takenSlug = `tenant-a-${stranger.toLowerCase()}`;
  const host = () => new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });

  beforeAll(async () => {
    const admin = host().admin;
    await admin.createTenant(staff, { id: mine, slug: `acme-${mine.toLowerCase()}`, name: 'Acme' });
    await admin.createTenant(staff, { id: stranger, slug: takenSlug, name: 'Tenant A' });
    await admin.createTenant(staff, { id: customer, slug: `customer-${customer.toLowerCase()}`, name: 'Customer', provisionedByTenant: mine });
    await admin.registerVertical(staff, { slug: managerVertical, name: 'Manager', source: 'builtin', entitlements: ['flows'] });
    await admin.setVerticalTenantProvisioner(staff, managerVertical, true);
    for (const [t, s, vertical] of [
      [mine, caller, 'acme/board-room'],
      [mine, target, 'acme/crm'],
      [mine, manager, managerVertical],
      [customer, authScope, 'managed-product'],
    ] as const) {
      await host().provisionScope(staff, { tenantId: t, scopeId: s, vertical });
      await admin.activateScope(staff, t, s);
    }
  });

  /** `lastError` is what the intent's previous settle journaled, as the vertical lists it back. */
  const intent = (
    kind: string,
    payload: unknown,
    attempts = 0,
    id = platformRequestId.parse(ulid()),
    lastError: string | null = null,
  ): PlatformRequest => ({
    id,
    kind,
    payload,
    requestedBy: principalId.parse(ulid()),
    impersonation: null,
    failure: null,
    status: 'pending',
    attempts,
    lastError,
    result: null,
    requestedAt: new Date().toISOString() as PlatformRequest['requestedAt'],
    settledAt: null,
  });

  type Settled = { status: string; lastError: string | null; failure: unknown };
  const drain = async (t: TenantId, s: ScopeId, vertical: string, request: PlatformRequest, handler: PlatformRequestHandler) => {
    const settled: Settled[] = [];
    const client = {
      listPlatformRequests: async () => [request],
      settlePlatformRequest: async (_t: unknown, _s: unknown, _id: unknown, o: Settled) => void settled.push(o),
    } as unknown as Pick<VerticalClient, 'listPlatformRequests' | 'settlePlatformRequest'>;
    const writes: Promise<void>[] = [];
    await drainScopePlatformRequests(
      client,
      { tenantId: t, scopeId: s, vertical, scope: { kind: 'app', forkedFrom: null }, lifecycle: { scope: 'active', tenant: 'active' } },
      { [request.kind]: handler },
      {
        recordFailure: (entry) => void writes.push(host().admin.recordOpsFailure({ actor: staff, ...entry })),
        listFailures: (filter) => host().admin.listOpsFailures(staff, filter),
      },
    );
    await Promise.all(writes);
    expect(settled).toHaveLength(1);
    return settled[0]!;
  };

  const foreign = () => {
    const upstream = `cf${ulid().toLowerCase()}`;
    return { upstream, text: `tenant ${stranger} said: permission denied: crm:read; something private; reference = ${upstream}` };
  };
  const referenceOf = (sentence: string | null) => /\(reference ([0-9A-HJKMNP-TV-Z]{26})\)$/.exec(sentence ?? '')?.[1];

  const expectWithheld = async (settled: Settled, sentence: string, raw: { upstream: string; text: string }, id: string): Promise<string> => {
    const reference = referenceOf(settled.lastError);
    expect(reference).toBeDefined();
    expect(settled.lastError).toBe(`${sentence} (reference ${reference})`);
    for (const text of [stranger, 'something private', raw.upstream, 'crm:read']) expect(JSON.stringify(settled)).not.toContain(text);
    const rows = await host().admin.listOpsFailures(staff, { reference: reference! });
    expect(rows.map((r) => [r.tenantId, r.stage])).toEqual([[null, 'transient']]);
    expect(rows[0]!.message).toBe(`[upstream reference = ${raw.upstream}] platform intent ${id} pending (${sentence}): ${raw.text}`);
    expect(await host().admin.listOpsFailures(staff, { tenantId: stranger })).toEqual([]);
    return reference!;
  };

  it('peer-invoke: the sentence and one reference across passes, one staff row, none for either tenant', async () => {
    const raw = foreign();
    const id = platformRequestId.parse(ulid());
    const handler = peerInvokeHandler({
      host: host(),
      actor: staff,
      resolveVerticalForScope: async () =>
        ({
          verticalInvoke: async () => {
            throw new ControlPlaneError(500, raw.text);
          },
        }) as unknown as VerticalClient,
    });
    const payload = { vertical: 'acme/crm', operation: 'customer/list' };
    const sentence = "the call to 'acme/crm' (operation 'customer/list') did not complete at its deployment";
    const first = await drain(mine, caller, 'acme/board-room', intent(PEER_INVOKE_KIND, payload, 0, id), handler);
    const reference = await expectWithheld(first, sentence, raw, id);
    const again = await drain(mine, caller, 'acme/board-room', intent(PEER_INVOKE_KIND, payload, 1, id, first.lastError), handler);
    expect(again.lastError).toBe(`${sentence} (reference ${reference})`);
    const filed = (await host().admin.listOpsFailures(staff, { scopeId: caller, operation: `intent.${PEER_INVOKE_KIND}` })).filter((r) =>
      r.message.includes(id),
    );
    expect(filed).toHaveLength(1);
    expect(await host().admin.listOpsFailures(staff, { tenantId: mine, operation: `intent.${PEER_INVOKE_KIND}` })).toEqual([]);
  });

  it("peer-invoke: the caller's operation in the sentence makes no marker; staff's row answers to the upstream's handle alone", async () => {
    const raw = foreign();
    const id = platformRequestId.parse(ulid());
    const handler = peerInvokeHandler({
      host: host(),
      actor: staff,
      resolveVerticalForScope: async () =>
        ({
          verticalInvoke: async () => {
            throw new ControlPlaneError(500, raw.text);
          },
        }) as unknown as VerticalClient,
    });
    // The operation is the caller's free text; both marker grammars are planted in it.
    const [a, b] = [`a${ulid().toLowerCase()}`, `b${ulid().toLowerCase()}`];
    const operation = `x reference = ${a} [upstream reference = ${b}]`;
    const planted = { vertical: 'acme/crm', operation };
    const said = `the call to 'acme/crm' (operation '${operation}') did not complete at its deployment`;
    const first = await drain(mine, caller, 'acme/board-room', intent(PEER_INVOKE_KIND, planted, 0, id), handler);
    const reference = referenceOf(first.lastError)!;
    expect(first.lastError).toBe(`${said} (reference ${reference})`);
    const rows = await host().admin.listOpsFailures(staff, { reference });
    expect(rows.map((r) => [r.tenantId, r.stage])).toEqual([[null, 'transient']]);
    expect(rows[0]!.message).toBe(
      `[upstream reference = ${raw.upstream}] platform intent ${id} pending (the call to 'acme/crm' (operation 'x reference = ${a} (upstream reference = ${b}]') did not complete at its deployment): ${raw.text}`,
    );
    const search = async (handle: string) =>
      (await host().admin.listOpsFailures(staff, { reference: handle, referenceInText: true })).map((r) => r.id);
    expect(await search(raw.upstream)).toEqual([rows[0]!.id]);
    expect(await search(a)).toEqual([]);
    expect(await search(b)).toEqual([]);
    const again = await drain(mine, caller, 'acme/board-room', intent(PEER_INVOKE_KIND, planted, 1, id, first.lastError), handler);
    expect(again.lastError).toBe(`${said} (reference ${reference})`);
  });

  it("provision-tenant: a failing provision journals the step; a slug another tenant holds is refused without naming it", async () => {
    const raw = foreign();
    const payloadFor = (slug: string) => ({
      tenant: { id: ulid(), slug, name: 'Customer' },
      instance: { vertical: 'managed-product', scopeId: ulid(), slug: 'main', name: 'Main', owner },
      entitlements: [{ key: 'flows', plan: 'pro' }],
    });
    const slug = `new-${ulid().toLowerCase()}`;
    const request = intent('provision-tenant', payloadFor(slug));
    const settled = await drain(
      mine, manager, managerVertical, request,
      provisionTenantHandler({
        host: host(),
        actor: staff,
        resolveVerticalForScope: async () =>
          ({
            provisionInstance: async () => {
              throw new ControlPlaneError(503, raw.text);
            },
          }) as unknown as VerticalClient,
      }),
    );
    expect(settled.status).toBe('pending');
    await expectWithheld(settled, `provisioning tenant '${slug}' did not complete while provisioning its 'managed-product' instance`, raw, request.id);

    const taken = await drain(
      mine, manager, managerVertical, intent('provision-tenant', payloadFor(takenSlug)),
      provisionTenantHandler({ host: host(), actor: staff, resolveVerticalForScope: async () => undefined }),
    );
    expect(taken).toMatchObject({ status: 'failed', lastError: `tenant slug '${takenSlug}' is already taken (slugs are unique)` });
    expect(JSON.stringify(taken)).not.toContain(stranger);
  });

  it("both kinds act only on a tenant the manager provisioned (#2564): one sentence for any other, existing or not", async () => {
    const unbound = { host: host(), actor: staff, resolveVerticalForScope: async () => undefined };
    const provision = (id: string, scope = ulid()) =>
      drain(mine, manager, managerVertical, intent('provision-tenant', {
        tenant: { id, slug: `own-${id.toLowerCase()}`, name: 'Own' },
        instance: { vertical: 'managed-product', scopeId: scope, slug: 'main', name: 'Main', owner },
        entitlements: [],
      }), provisionTenantHandler(unbound));
    // The manager's own tenant, created by the first pass, passes the check on the retry and
    // reaches the next refusal: no deployment is bound in this file.
    const [own, ownScope] = [ulid(), ulid()];
    for (let pass = 0; pass < 2; pass++) {
      expect((await provision(own, ownScope)).lastError).toBe("no deployment is bound for vertical 'managed-product'");
    }
    const refused = {
      status: 'failed',
      lastError: "the payload's tenant was not provisioned by this vertical's tenant",
      failure: { origin: 'platform', code: 'permission_denied', permission: null },
    };
    expect(await provision(stranger)).toMatchObject(refused);
    for (const t of [stranger, ulid()]) {
      const settled = await drain(mine, manager, managerVertical,
        intent('set-entitlements', { tenantId: t, authScopeId: ulid(), plan: 'x', entitlements: [] }),
        setEntitlementsHandler(unbound));
      expect(settled).toMatchObject(refused);
    }
    expect(await host().admin.listScopes(staff, { tenantId: stranger })).toEqual([]);
  });

  it("set-entitlements: a failing reconcile of the managed tenant's instance journals the step", async () => {
    const raw = foreign();
    const request = intent('set-entitlements', { tenantId: customer, authScopeId: authScope, plan: 'pro', entitlements: [{ key: 'flows', plan: 'pro' }] });
    const settled = await drain(
      mine, manager, managerVertical, request,
      setEntitlementsHandler({
        host: host(),
        actor: staff,
        resolveVerticalForScope: async () =>
          ({
            reconcileInstance: async () => {
              throw new ControlPlaneError(502, raw.text);
            },
          }) as unknown as VerticalClient,
      }),
    );
    expect(settled.status).toBe('pending');
    await expectWithheld(settled, `setting the entitlements of tenant ${customer} did not complete while reconciling its instance`, raw, request.id);
  });

  it('set-entitlements: a pass that fails one step further is its own staff row and reference; the same step again reuses it', async () => {
    const id = platformRequestId.parse(ulid());
    const payload = { tenantId: customer, authScopeId: authScope, plan: 'pro', entitlements: [{ key: 'flows', plan: 'pro' }] };
    const atResolve = (text: string) =>
      setEntitlementsHandler({
        host: host(),
        actor: staff,
        resolveVerticalForScope: async () => {
          throw new ControlPlaneError(503, text);
        },
      });
    const atReconcile = (text: string) =>
      setEntitlementsHandler({
        host: host(),
        actor: staff,
        resolveVerticalForScope: async () =>
          ({
            reconcileInstance: async () => {
              throw new ControlPlaneError(502, text);
            },
          }) as unknown as VerticalClient,
      });
    const sentence = (step: string) => `setting the entitlements of tenant ${customer} did not complete while ${step}`;

    const one = foreign();
    const first = await drain(mine, manager, managerVertical, intent('set-entitlements', payload, 0, id), atResolve(one.text));
    const firstReference = await expectWithheld(first, sentence('reconciling its entitlements'), one, id);

    const two = foreign();
    const second = await drain(mine, manager, managerVertical, intent('set-entitlements', payload, 1, id, first.lastError), atReconcile(two.text));
    const secondReference = await expectWithheld(second, sentence('reconciling its instance'), two, id);
    expect(secondReference).not.toBe(firstReference);
    expect((await host().admin.listOpsFailures(staff, { reference: firstReference }))[0]!.message).toContain(one.text);

    const third = await drain(
      mine, manager, managerVertical, intent('set-entitlements', payload, 2, id, second.lastError), atReconcile(foreign().text),
    );
    expect(third.lastError).toBe(`${sentence('reconciling its instance')} (reference ${secondReference})`);
    const filed = (await host().admin.listOpsFailures(staff, { scopeId: manager, operation: 'intent.set-entitlements' })).filter((r) =>
      r.message.includes(id),
    );
    expect(filed.map((r) => r.reference).sort()).toEqual([firstReference, secondReference].sort());
  });
});
