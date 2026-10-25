import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
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
import { ControlPlaneError } from '@substrat-run/control-plane-client';
import {
  drainScopePlatformRequests,
  MAX_PLATFORM_REQUEST_ATTEMPTS,
  peerInvokeHandler,
  provisionTenantHandler,
  setEntitlementsHandler,
  WITHHELD_REFILE_MS,
  type PlatformRequestHandler,
  type VerticalClient,
} from '../src/index.js';

/**
 * #2556: the settle journals a handler's error in the drained scope's own platform-requests
 * journal, which the scope's vertical reads (#841). Three handlers meet text from beyond that
 * scope's deployment or tenant: peer-invoke (the target vertical's deployment), provision-tenant and
 * set-entitlements (the managed tenant, and its deployment). Their journal carries a fixed sentence
 * and the platform's reference; staff read the text under that reference. Two scopes of one
 * tenant, and a second tenant whose id the text names. The workerd twin is
 * `adapter-cloudflare/test/intent-journal-text.test.ts`.
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
  let dir: string;
  let host: SqliteScopeHost;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'intent-journal-text-'));
    host = new SqliteScopeHost({ dir });
    await host.admin.createTenant(staff, { id: mine, slug: 'acme', name: 'Acme' });
    await host.admin.createTenant(staff, { id: stranger, slug: 'tenant-a', name: 'Tenant A' });
    await host.admin.createTenant(staff, { id: customer, slug: 'customer', name: 'Customer', provisionedByTenant: mine });
    await host.admin.registerVertical(staff, { slug: 'manager-console', name: 'Manager', source: 'builtin', entitlements: ['flows'] });
    await host.admin.setVerticalTenantProvisioner(staff, 'manager-console', true);
    for (const [t, s, vertical] of [
      [mine, caller, 'acme/board-room'],
      [mine, target, 'acme/crm'],
      [mine, manager, 'manager-console'],
      [customer, authScope, 'managed-product'],
    ] as const) {
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical });
      await host.admin.activateScope(staff, t, s);
    }
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
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
  /** One drain pass of `request` in (`t`, `s`), through the real host's ledger; what it settled. */
  const drain = async (
    t: TenantId,
    s: ScopeId,
    vertical: string,
    request: PlatformRequest,
    handler: PlatformRequestHandler,
    now?: Date,
  ): Promise<Settled> => {
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
        recordFailure: (entry) => void writes.push(host.admin.recordOpsFailure({ actor: staff, ...entry })),
        listFailures: (filter) => host.admin.listOpsFailures(staff, filter),
        ...(now ? { now: () => now } : {}),
      },
    );
    await Promise.all(writes);
    expect(settled).toHaveLength(1);
    return settled[0]!;
  };

  /** Text naming another tenant, a permission key and an upstream trace handle. */
  const foreign = () => {
    const upstream = `cf${ulid().toLowerCase()}`;
    return { upstream, text: `tenant ${stranger} said: permission denied: crm:read; something private; reference = ${upstream}` };
  };

  /** The reference a journaled withheld sentence ends with. */
  const referenceOf = (sentence: string | null) => /\(reference ([0-9A-HJKMNP-TV-Z]{26})\)$/.exec(sentence ?? '')?.[1];

  /** What the vertical reads carries none of the text, and staff find it, and only it, by the reference. */
  const expectWithheld = async (settled: Settled, sentence: string, raw: { upstream: string; text: string }, id: string): Promise<string> => {
    const reference = referenceOf(settled.lastError);
    expect(reference).toBeDefined();
    expect(settled.lastError).toBe(`${sentence} (reference ${reference})`);
    for (const text of [stranger, 'something private', raw.upstream, 'crm:read']) expect(JSON.stringify(settled)).not.toContain(text);
    const rows = await host.admin.listOpsFailures(staff, { reference: reference! });
    expect(rows.map((r) => [r.tenantId, r.stage])).toEqual([[null, 'transient']]);
    expect(rows[0]!.message).toBe(`[upstream reference = ${raw.upstream}] platform intent ${id} pending (${sentence}): ${raw.text}`);
    // Staff's search by the upstream handle reaches the same row.
    expect((await host.admin.listOpsFailures(staff, { reference: raw.upstream, referenceInText: true })).map((r) => r.id)).toEqual([rows[0]!.id]);
    return reference!;
  };

  describe('peer-invoke: the target is another deployment', () => {
    const throwing = (text: string): PlatformRequestHandler =>
      peerInvokeHandler({
        host,
        actor: staff,
        resolveVerticalForScope: async () =>
          ({
            verticalInvoke: async () => {
              throw new ControlPlaneError(500, text);
            },
          }) as unknown as VerticalClient,
      });
    const payload = { vertical: 'acme/crm', operation: 'customer/list' };
    const sentence = "the call to 'acme/crm' (operation 'customer/list') did not complete at its deployment";

    it("the caller's operation in the sentence makes no marker: staff's row answers to the upstream's handle alone", async () => {
      const raw = foreign();
      const id = platformRequestId.parse(ulid());
      // The operation is the caller's free text; both marker grammars are planted in it.
      const [a, b] = [`a${ulid().toLowerCase()}`, `b${ulid().toLowerCase()}`];
      const operation = `x reference = ${a} [upstream reference = ${b}]`;
      const neutral = `x reference = ${a} (upstream reference = ${b}]`;
      const planted = { vertical: 'acme/crm', operation };
      const said = `the call to 'acme/crm' (operation '${operation}') did not complete at its deployment`;
      const first = await drain(mine, caller, 'acme/board-room', intent(PEER_INVOKE_KIND, planted, 0, id), throwing(raw.text));
      const reference = referenceOf(first.lastError)!;
      expect(first.lastError).toBe(`${said} (reference ${reference})`);
      const rows = await host.admin.listOpsFailures(staff, { reference });
      expect(rows.map((r) => [r.tenantId, r.stage])).toEqual([[null, 'transient']]);
      expect(rows[0]!.message).toBe(
        `[upstream reference = ${raw.upstream}] platform intent ${id} pending (the call to 'acme/crm' (operation '${neutral}') did not complete at its deployment): ${raw.text}`,
      );
      const search = async (handle: string) =>
        (await host.admin.listOpsFailures(staff, { reference: handle, referenceInText: true })).map((r) => r.id);
      expect(await search(raw.upstream)).toEqual([rows[0]!.id]);
      expect(await search(a)).toEqual([]);
      expect(await search(b)).toEqual([]);

      // The next pass compares the opening as the row stored it, so it reuses the reference.
      const again = await drain(
        mine, caller, 'acme/board-room', intent(PEER_INVOKE_KIND, planted, 1, id, first.lastError), throwing(foreign().text),
      );
      expect(again.lastError).toBe(`${said} (reference ${reference})`);

      // Upstream text with no handle of its own: no marker at all, whatever the operation spells.
      const bare = platformRequestId.parse(ulid());
      const quiet = await drain(mine, caller, 'acme/board-room', intent(PEER_INVOKE_KIND, planted, 0, bare), throwing('upstream timed out'));
      const [row] = await host.admin.listOpsFailures(staff, { reference: referenceOf(quiet.lastError)! });
      expect(row!.message).toBe(
        `platform intent ${bare} pending (the call to 'acme/crm' (operation '${neutral}') did not complete at its deployment): upstream timed out`,
      );
    });

    it('journals the sentence and a reference; one staff row per intent and sentence, the tenant none', async () => {
      const raw = foreign();
      const id = platformRequestId.parse(ulid());
      const first = await drain(mine, caller, 'acme/board-room', intent(PEER_INVOKE_KIND, payload, 0, id), throwing(raw.text));
      expect(first.status).toBe('pending');
      // Origin and code stay; the permission key read from the target's text does not.
      expect(first.failure).toEqual({ origin: 'platform', code: null, permission: null });
      const reference = await expectWithheld(first, sentence, raw, id);
      // Nothing under either tenant: a transient pass files staff's row only.
      expect(await host.admin.listOpsFailures(staff, { tenantId: mine, operation: `intent.${PEER_INVOKE_KIND}` })).toEqual([]);
      expect(await host.admin.listOpsFailures(staff, { tenantId: stranger })).toEqual([]);

      // A later pass of the same intent, inside the window: the same reference, and no second row.
      const again = await drain(
        mine, caller, 'acme/board-room', intent(PEER_INVOKE_KIND, payload, 1, id, first.lastError), throwing(foreign().text),
      );
      expect(again.lastError).toBe(`${sentence} (reference ${reference})`);
      const filed = async () =>
        (await host.admin.listOpsFailures(staff, { scopeId: caller, operation: `intent.${PEER_INVOKE_KIND}` })).filter((r) =>
          r.message.includes(id),
        );
      expect(await filed()).toHaveLength(1);

      // Another intent of the same kind and scope is its own row, under its own reference, even
      // when its journal names this intent's reference: staff's row under it is not about it.
      const other = await drain(
        mine, caller, 'acme/board-room', intent(PEER_INVOKE_KIND, payload, 1, undefined, first.lastError), throwing(foreign().text),
      );
      expect(referenceOf(other.lastError)).not.toBe(reference);

      // Past the window, the condition is filed again, under a new reference.
      const later = new Date(Date.now() + WITHHELD_REFILE_MS + 60_000);
      const refiled = await drain(
        mine, caller, 'acme/board-room', intent(PEER_INVOKE_KIND, payload, 2, id, again.lastError), throwing(raw.text), later,
      );
      expect(referenceOf(refiled.lastError)).not.toBe(reference);
      expect(await filed()).toHaveLength(2);
    });

    it('a ledger that cannot be read files anew and leaves staff a note naming the unconfirmed reference', async () => {
      const raw = foreign();
      const id = platformRequestId.parse(ulid());
      const first = await drain(mine, caller, 'acme/board-room', intent(PEER_INVOKE_KIND, payload, 0, id), throwing(raw.text));
      const reference = referenceOf(first.lastError)!;
      const settled: Settled[] = [];
      const writes: Promise<void>[] = [];
      await drainScopePlatformRequests(
        {
          listPlatformRequests: async () => [intent(PEER_INVOKE_KIND, payload, 1, id, first.lastError)],
          settlePlatformRequest: async (_t: unknown, _s: unknown, _id: unknown, o: Settled) => void settled.push(o),
        } as unknown as Pick<VerticalClient, 'listPlatformRequests' | 'settlePlatformRequest'>,
        { tenantId: mine, scopeId: caller, vertical: 'acme/board-room', scope: { kind: 'app', forkedFrom: null }, lifecycle: { scope: 'active', tenant: 'active' } },
        { [PEER_INVOKE_KIND]: throwing(raw.text) },
        {
          recordFailure: (entry) => void writes.push(host.admin.recordOpsFailure({ actor: staff, ...entry })),
          listFailures: async () => {
            throw new Error('ledger unavailable');
          },
        },
      );
      await Promise.all(writes);
      const anew = referenceOf(settled[0]!.lastError);
      expect(anew).toBeDefined();
      expect(anew).not.toBe(reference);
      const rows = (await host.admin.listOpsFailures(staff, { scopeId: caller, operation: `intent.${PEER_INVOKE_KIND}` })).filter((r) =>
        r.message.includes(id),
      );
      expect(rows.every((r) => r.tenantId === null)).toBe(true);
      expect(rows.filter((r) => r.stage === 'transient').map((r) => r.reference).sort()).toEqual([reference, anew].sort());
      const notes = rows.filter((r) => r.stage === 'transient-lookup');
      expect(notes).toHaveLength(1);
      expect(notes[0]!.message).toBe(
        `platform intent ${id} pending: reference ${reference} could not be confirmed in the failure ledger, so this pass files anew: ledger unavailable`,
      );
    });

    it('the give-up journals the sentence under the pair\'s reference; the tenant\'s row carries none of the text', async () => {
      const raw = foreign();
      const id = platformRequestId.parse(ulid());
      const settled = await drain(
        mine, caller, 'acme/board-room',
        intent(PEER_INVOKE_KIND, payload, MAX_PLATFORM_REQUEST_ATTEMPTS - 1, id),
        throwing(raw.text),
      );
      const gaveUp = `gave up after ${MAX_PLATFORM_REQUEST_ATTEMPTS} drain attempts`;
      expect(settled.status).toBe('failed');
      const reference = referenceOf(settled.lastError)!;
      expect(settled.lastError).toBe(`${gaveUp} — last error: ${sentence} (reference ${reference})`);
      for (const text of [stranger, 'something private', raw.upstream]) expect(JSON.stringify(settled)).not.toContain(text);
      const pair = await host.admin.listOpsFailures(staff, { reference });
      expect(pair.map((r) => [r.tenantId, r.stage])).toEqual([
        [mine, 'attempt-ceiling'],
        [null, 'attempt-ceiling'],
      ]);
      expect(pair[0]!.message).toBe(`platform intent ${id} ${gaveUp} (reference ${reference})`);
      expect(pair[1]!.message).toBe(`[upstream reference = ${raw.upstream}] platform intent ${id} ${gaveUp} — last error: ${raw.text}`);
    });

    it("a refusal the platform writes about the caller's own tenant is journaled as it is", async () => {
      const settled = await drain(
        mine, caller, 'acme/board-room',
        intent(PEER_INVOKE_KIND, { vertical: 'acme/absent', operation: 'x/y' }),
        throwing('never reached'),
      );
      expect(settled).toMatchObject({ status: 'failed', lastError: "vertical 'acme/absent' is not installed in this tenant" });
    });
  });

  describe('provision-tenant: the tenant being provisioned is not the manager\'s', () => {
    const payloadFor = (slug: string) => ({
      tenant: { id: ulid(), slug, name: 'Customer' },
      instance: { vertical: 'managed-product', scopeId: ulid(), slug: 'main', name: 'Main', owner },
      entitlements: [{ key: 'flows', plan: 'pro' }],
    });

    it('a failing provision journals the step and a reference; staff read the deployment\'s text', async () => {
      const raw = foreign();
      const slug = `new-${ulid().toLowerCase()}`;
      const request = intent('provision-tenant', payloadFor(slug));
      const settled = await drain(
        mine, manager, 'manager-console', request,
        provisionTenantHandler({
          host,
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
      await expectWithheld(
        settled,
        `provisioning tenant '${slug}' did not complete while provisioning its 'managed-product' instance`,
        raw,
        request.id,
      );
    });

    it('a slug another tenant holds is refused without naming that tenant', async () => {
      const settled = await drain(
        mine, manager, 'manager-console', intent('provision-tenant', payloadFor('tenant-a')),
        provisionTenantHandler({ host, actor: staff, resolveVerticalForScope: async () => undefined }),
      );
      expect(settled).toMatchObject({ status: 'failed', lastError: "tenant slug 'tenant-a' is already taken (slugs are unique)" });
      expect(JSON.stringify(settled)).not.toContain(stranger);
    });
  });

  it("set-entitlements: an unbound deployment is named by the payload's ids, not by what the managed scope runs", async () => {
    const settled = await drain(
      mine, manager, 'manager-console',
      intent('set-entitlements', { tenantId: customer, authScopeId: authScope, plan: 'pro', entitlements: [{ key: 'flows', plan: 'pro' }] }),
      setEntitlementsHandler({ host, actor: staff, resolveVerticalForScope: async () => undefined }),
    );
    expect(settled).toMatchObject({ status: 'failed', lastError: `no deployment is bound for scope ${authScope} of tenant ${customer}` });
    expect(settled.lastError).not.toContain('managed-product');
  });

  it("set-entitlements: a failing reconcile of the managed tenant's instance journals the step and a reference", async () => {
    const raw = foreign();
    const request = intent('set-entitlements', {
      tenantId: customer,
      authScopeId: authScope,
      plan: 'pro',
      entitlements: [{ key: 'flows', plan: 'pro' }],
    });
    const settled = await drain(
      mine, manager, 'manager-console', request,
      setEntitlementsHandler({
        host,
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
    await expectWithheld(
      settled,
      `setting the entitlements of tenant ${customer} did not complete while reconciling its instance`,
      raw,
      request.id,
    );
  });

  it('set-entitlements: a pass that fails one step further is its own staff row and reference; the same step again reuses it', async () => {
    const id = platformRequestId.parse(ulid());
    const payload = { tenantId: customer, authScopeId: authScope, plan: 'pro', entitlements: [{ key: 'flows', plan: 'pro' }] };
    const atResolve = (text: string) =>
      setEntitlementsHandler({
        host,
        actor: staff,
        resolveVerticalForScope: async () => {
          throw new ControlPlaneError(503, text);
        },
      });
    const atReconcile = (text: string) =>
      setEntitlementsHandler({
        host,
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
    const first = await drain(mine, manager, 'manager-console', intent('set-entitlements', payload, 0, id), atResolve(one.text));
    const firstReference = await expectWithheld(first, sentence('reconciling its entitlements'), one, id);

    const two = foreign();
    const second = await drain(
      mine, manager, 'manager-console', intent('set-entitlements', payload, 1, id, first.lastError), atReconcile(two.text),
    );
    const secondReference = await expectWithheld(second, sentence('reconciling its instance'), two, id);
    expect(secondReference).not.toBe(firstReference);
    // The first pass's row still says the first step's text; the second step's has its own.
    expect((await host.admin.listOpsFailures(staff, { reference: firstReference }))[0]!.message).toContain(one.text);

    const third = await drain(
      mine, manager, 'manager-console', intent('set-entitlements', payload, 2, id, second.lastError), atReconcile(foreign().text),
    );
    expect(third.lastError).toBe(`${sentence('reconciling its instance')} (reference ${secondReference})`);
    const filed = (await host.admin.listOpsFailures(staff, { scopeId: manager, operation: 'intent.set-entitlements' })).filter((r) =>
      r.message.includes(id),
    );
    expect(filed.map((r) => r.reference).sort()).toEqual([firstReference, secondReference].sort());
  });
});
