import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import {
  PEER_INVOKE_KIND,
  platformRequestId,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type PlatformRequest,
} from '@substrat-run/contracts';
import { peerInvokeHandler } from '../src/platform-drain.js';
import type { VerticalClient } from '../src/vertical-client.js';

/**
 * The ASYNCHRONOUS leg of a peer call (#1706) — the one module code can use, since an
 * operation, a consumer and a schedule all run inside the scope's Durable Object, where
 * there is no network and no egress worker to name the caller.
 *
 * The property this file exists for: **the caller is the scope the intent was drained
 * from**. The payload has no field for one, and a payload that tries to name a tenant or a
 * caller changes nothing about who the target is told called.
 */

function intent(over: Partial<PlatformRequest> = {}): PlatformRequest {
  return {
    id: platformRequestId.parse(ulid()),
    kind: PEER_INVOKE_KIND,
    payload: {},
    requestedBy: principalId.parse(ulid()),
    status: 'pending',
    attempts: 0,
    lastError: null,
    result: null,
    requestedAt: new Date().toISOString() as PlatformRequest['requestedAt'],
    settledAt: null,
    ...over,
  };
}

describe('peerInvokeHandler (#1706)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const other = tenantId.parse(ulid());
  const caller = scopeId.parse(ulid()); // the scope the intent is drained from
  const target = scopeId.parse(ulid()); // the CRM instance in t
  const elsewhere = scopeId.parse(ulid()); // a CRM instance in the OTHER tenant

  /** A vertical client recording what the platform asked its deployment to do. */
  const calls: Parameters<VerticalClient['verticalInvoke']>[0][] = [];
  const client = {
    verticalInvoke: async (input: Parameters<VerticalClient['verticalInvoke']>[0]) => {
      calls.push(input);
      return { listed: 2 };
    },
  } as unknown as VerticalClient;

  const handler = (over: { client?: VerticalClient | undefined } = {}) =>
    peerInvokeHandler({
      host,
      actor: staff,
      resolveVerticalForScope: async () => ('client' in over ? over.client : client),
    });

  const ctx = { tenantId: t, scopeId: caller, vertical: 'acme/board-room' };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-peer-invoke-'));
    host = new SqliteScopeHost({ dir });
    for (const [tenant, slug] of [
      [t, 'acme'],
      [other, 'other'],
    ] as const) {
      await host.admin.createTenant(staff, { id: tenant, slug, name: slug });
    }
    await host.provisionScope(staff, { tenantId: t, scopeId: caller, vertical: 'acme/board-room' });
    await host.admin.activateScope(staff, t, caller);
    await host.provisionScope(staff, { tenantId: t, scopeId: target, vertical: 'acme/crm' });
    await host.admin.activateScope(staff, t, target);
    await host.provisionScope(staff, { tenantId: other, scopeId: elsewhere, vertical: 'acme/crm' });
    await host.admin.activateScope(staff, other, elsewhere);
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('delivers to the target instance in the CALLER’s tenant, as the caller', async () => {
    const request = intent({ payload: { vertical: 'acme/crm', operation: 'customer/list' } });
    const outcome = await handler()(ctx, request);

    expect(outcome.status).toBe('done');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      caller: { vertical: 'acme/board-room', scope: caller },
      tenantId: t,
      scopeId: target, // the instance in t — never the one in the other tenant
      operation: 'customer/list',
      // At-least-once: the intent id is the key, so a redelivery replays rather than reruns.
      idempotencyKey: request.id,
    });
  });

  it('THE property: a payload cannot name its own caller or another tenant', async () => {
    calls.length = 0;
    const outcome = await handler()(
      ctx,
      intent({
        payload: {
          vertical: 'acme/crm',
          operation: 'customer/list',
          // Everything an attacker would try. The payload schema has no field for a caller,
          // and the tenant is the drained scope's, so these are simply not read.
          caller: { vertical: 'acme/somebody-else', scope: scopeId.parse(ulid()) },
          tenantId: other,
          scopeId: elsewhere,
        },
      }),
    );

    expect(outcome.status).toBe('done');
    expect(calls[0]).toMatchObject({
      caller: { vertical: 'acme/board-room', scope: caller },
      tenantId: t,
      scopeId: target,
    });
  });

  it('refuses a target that is not installed in the caller’s tenant — the other tenant’s is not reachable', async () => {
    calls.length = 0;
    const outcome = await handler()(
      { tenantId: other, scopeId: elsewhere, vertical: 'acme/crm' },
      intent({ payload: { vertical: 'acme/absent', operation: 'x/y' } }),
    );
    expect(outcome).toMatchObject({ status: 'failed' });
    expect(String(outcome.error)).toMatch(/not installed in this tenant/);
    expect(calls).toHaveLength(0);
  });

  it('rechecks tenant and scope suspension on each delivery, with an active twin', async () => {
    const request = intent({ payload: { vertical: 'acme/crm', operation: 'customer/list' } });
    for (const suspend of ['tenant', 'scope']) {
      calls.length = 0;
      if (suspend === 'tenant') await host.admin.setTenantStatus(staff, t, 'suspended');
      else await host.admin.suspendScope(staff, t, caller);
      try {
        expect((await handler()(ctx, request)).status).toBe('failed');
        expect(calls).toHaveLength(0);
      } finally {
        if (suspend === 'tenant') await host.admin.setTenantStatus(staff, t, 'active');
        else await host.admin.unsuspendScope(staff, t, caller);
      }
      expect((await handler()(ctx, request)).status).toBe('done');
      expect(calls).toHaveLength(1);
    }
  });

  it('refuses active previews and forged caller identity before delivery', async () => {
    const preview = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: preview, vertical: ctx.vertical, kind: 'preview' });
    await host.admin.activateScope(staff, t, preview);
    for (const from of [{ ...ctx, scopeId: preview }, { ...ctx, vertical: 'acme/stranger' }, { ...ctx, scopeId: scopeId.parse(ulid()) }]) {
      calls.length = 0;
      expect((await handler()(from, intent({ payload: { vertical: 'acme/crm', operation: 'customer/list' } }))).status).toBe('failed');
      expect(calls).toHaveLength(0);
    }
  });

  it('refuses a vertical calling itself', async () => {
    const outcome = await handler()(ctx, intent({ payload: { vertical: 'acme/board-room', operation: 'x/y' } }));
    expect(outcome).toMatchObject({ status: 'failed' });
    expect(String(outcome.error)).toMatch(/cannot peer-call itself/);
  });

  it('refuses when no deployment serves the target', async () => {
    const outcome = await handler({ client: undefined })(
      ctx,
      intent({ payload: { vertical: 'acme/crm', operation: 'customer/list' } }),
    );
    expect(outcome).toMatchObject({ status: 'failed' });
    expect(String(outcome.error)).toMatch(/no deployment serves/);
  });

  it('refuses a malformed payload rather than guessing at it', async () => {
    await expect(handler()(ctx, intent({ payload: { operation: 'customer/list' } }))).rejects.toThrow();
  });

  describe('the caller’s `substrat.calls` gates this leg too (#1706)', () => {
    /** Publish a version of the caller whose stored manifest declares `calls`. */
    let versionCounter = 0;
    const publish = async (calls: string[] | undefined): Promise<string> => {
      const id = ulid();
      await host.admin.publishVersion(staff, {
        id,
        verticalSlug: 'acme/board-room',
        version: `1.0.${versionCounter++}`,
        manifestDigest: `m-${id}`,
        permissionDigest: 'p',
        migrationDigest: 'g',
        deploymentRef: null,
        manifestJson: JSON.stringify({ slug: 'acme/board-room', ...(calls === undefined ? {} : { calls }) }),
      });
      return id;
    };

    beforeAll(async () => {
      await host.admin.registerVertical(staff, {
        slug: 'acme/board-room',
        name: 'Board room',
        source: 'builtin',
      });
    });

    it('refuses a target the caller did not declare, and says what to declare', async () => {
      calls.length = 0;
      const versionId = await publish(['acme/somebody-else']);
      const outcome = await handler()(
        { ...ctx, versionId },
        intent({ payload: { vertical: 'acme/crm', operation: 'customer/list' } }),
      );
      expect(outcome).toMatchObject({ status: 'failed' });
      expect(String(outcome.error)).toMatch(/substrat\.calls/);
      expect(calls).toHaveLength(0);
    });

    it('twin: a declared target goes through', async () => {
      calls.length = 0;
      const versionId = await publish(['acme/crm']);
      const outcome = await handler()(
        { ...ctx, versionId },
        intent({ payload: { vertical: 'acme/crm', operation: 'customer/list' } }),
      );
      expect(outcome.status).toBe('done');
      expect(calls).toHaveLength(1);
    });

    it('a version pushed before the declaration existed is unenforced, as a pre-#303 outbound is', async () => {
      calls.length = 0;
      const versionId = await publish(undefined);
      const outcome = await handler()(
        { ...ctx, versionId },
        intent({ payload: { vertical: 'acme/crm', operation: 'customer/list' } }),
      );
      expect(outcome.status).toBe('done');
      expect(calls).toHaveLength(1);
    });

    /**
     * A declaration that cannot be READ is not an absent declaration (#1719 review). `null`
     * means "pushed before `calls` existed" and is unenforced by design, so swallowing a
     * lookup failure into `null` would turn a storage blip into "every target is declared" —
     * the gate off, silently, on exactly the path it guards.
     */
    it('a version lookup that THROWS leaves the intent pending — it never falls through as undeclared', async () => {
      calls.length = 0;
      const versionId = await publish(['acme/somebody-else']);
      const broken = peerInvokeHandler({
        host: {
          ...host,
          admin: {
            ...host.admin,
            getVersion: async () => {
              throw new Error('directory unavailable');
            },
          },
        } as unknown as typeof host,
        actor: staff,
        resolveVerticalForScope: async () => client,
      });
      const outcome = await broken(
        { ...ctx, versionId },
        intent({ payload: { vertical: 'acme/crm', operation: 'customer/list' } }),
      );
      // Pending, not failed: a storage fault is transient, and the drain retries it to its
      // attempt ceiling before settling it. What must never happen is the call going through.
      expect(outcome.status).toBe('pending');
      expect(String(outcome.error)).toMatch(/directory unavailable/);
      expect(calls).toHaveLength(0);
    });

    it('a version the directory does not have fails — an unreadable declaration is not a blank one', async () => {
      calls.length = 0;
      const outcome = await handler()(
        { ...ctx, versionId: ulid() },
        intent({ payload: { vertical: 'acme/crm', operation: 'customer/list' } }),
      );
      expect(outcome.status).toBe('failed');
      expect(String(outcome.error)).toMatch(/not in the directory/);
      expect(calls).toHaveLength(0);
    });
  });

  it('a malformed target slug is refused where it is WRITTEN, not two drain passes later', async () => {
    // The payload's `vertical` is held to the slug grammar by the schema the handler parses
    // first (#1719 review). Before that it was any non-empty string, so a typo passed the
    // enqueue, sat in the outbox, and failed at delivery — where the author who wrote it is
    // no longer looking.
    calls.length = 0;
    await expect(
      handler()(ctx, intent({ payload: { vertical: 'Acme CRM', operation: 'customer/list' } })),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('is ambiguous, never a guess, when the tenant runs two instances of the target', async () => {
    const second = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: second, vertical: 'acme/crm' });
    await host.admin.activateScope(staff, t, second);
    calls.length = 0;

    const outcome = await handler()(ctx, intent({ payload: { vertical: 'acme/crm', operation: 'customer/list' } }));
    expect(outcome).toMatchObject({ status: 'failed' });
    expect(String(outcome.error)).toMatch(/runs 2 instances/);
    expect(calls).toHaveLength(0);

    await host.admin.archiveScope(staff, t, second); // leave the fixture as we found it
  });
});
