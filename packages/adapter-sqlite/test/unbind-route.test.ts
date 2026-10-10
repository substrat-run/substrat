/**
 * vertical-auth's generic unbind route (#1686) over a REAL pure-SQLite host — the lever beside a
 * binding invite, mounted the way a vertical mounts it. The bound is the host's: the binding's key
 * on THAT record, judged in the write's scope task. What is held: a caller without the key is
 * refused 403 naming it and nothing moves; the clerk's unbind clears the column and takes the
 * portal away; a second unbind answers that nobody was named; a type the registry binds nothing on
 * is 404; nobody signed in is the vertical's own 401.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { platformActorId, principalId, scopeId, tenantId, type PrincipalId } from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { BIND_INVITE, BIND_MEMBER, BIND_SHAPE, bindMod } from '@substrat-run/contract-tests';
import { mountUnbindRoute } from '@substrat-run/vertical-auth/invite-routes';
import { SqliteScopeHost } from '../src/index.js';

describe('the unbind route over the SQLite host (#1686)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let app: Hono<{ Bindings: Record<string, never> }>;
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const node = { tenantId: t, scopeId: s };
  const clerk = principalId.parse(ulid());
  const outsider = principalId.parse(ulid());

  const call = (path: string, caller?: PrincipalId) =>
    app.request(path, { method: 'POST', headers: caller ? { 'x-caller': caller } : {} }, {});
  const principalOf = async (id: string) =>
    ((await (await host.getScope(clerk, t, s)).invoke<{ principal: string | null }[]>('bind/sql', {
      sql: 'SELECT principal FROM bind_records WHERE id = ?',
      params: [id],
    }))[0]?.principal ?? null);
  const reads = async (who: PrincipalId, id: string) =>
    (await host.getScope(who, t, s)).invoke('bind/read', { id }).then(() => true, () => false);

  /** A record bound to a fresh person through a real binding invite. */
  const bound = async () => {
    const id = ulid();
    await (await host.getScope(clerk, t, s)).invoke('bind/put', {
      sql: 'INSERT INTO bind_records (id, principal, email, fate) VALUES (?, NULL, NULL, NULL)',
      params: [id],
    });
    const who = principalId.parse(ulid());
    await host.admin.assignRole(staff, { principalId: who, roleKey: 'member', node });
    const out = await host.mintBecomeCapabilityBounded(t, s, clerk, { principal: who, maxUses: 1, bind: { entity: { entityType: 'brecord', entityId: id } } });
    if (!out.ok) throw new Error(JSON.stringify(out));
    await host.exchangeCapability(t, s, out.minted.secret, { mode: 'become' });
    return { id, who };
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-unbind-route-'));
    host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)) });
    host.registerModule(bindMod);
    await host.admin.createTenant(staff, { id: t, slug: `unbind-${t.toLowerCase()}`, name: 'Unbind' });
    await host.admin.grantEntitlement(staff, t, 'bind');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'bind-vertical' });
    await host.admin.activateScope(staff, t, s);
    await host.admin.defineRole(staff, t, { key: 'clerk', permissions: [BIND_INVITE, BIND_MEMBER], source: 'vertical' });
    await host.admin.defineRole(staff, t, { key: 'member', permissions: [BIND_MEMBER], source: 'vertical' });
    await host.admin.assignRole(staff, { principalId: clerk, roleKey: 'clerk', node });
    await host.admin.assignRole(staff, { principalId: outsider, roleKey: 'member', node });
    await host.admin.reconcileEntityGrantShapes(staff, node, [BIND_SHAPE]);

    app = new Hono();
    mountUnbindRoute(app, {
      nodeFor: () => node,
      callerOf: async (c) => {
        const who = c.req.header('x-caller');
        if (!who) throw new HTTPException(401, { message: 'sign in first' });
        return { principal: principalId.parse(who) };
      },
      unbindEntityHolderBounded: (_env, n, caller, entity) => host.unbindEntityHolderBounded(n.tenantId, n.scopeId, caller, entity),
    });
    app.onError((err, c) => (err instanceof HTTPException ? c.json({ message: err.message }, err.status) : c.json({ message: String(err) }, 500)));
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a caller without the key on the record — 403, naming it, and nothing moves', async () => {
    const { id, who } = await bound();
    const res = await call(`/api/bindings/brecord/${id}/unbind`, outsider);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toContain(BIND_INVITE);
    expect(await principalOf(id)).toBe(who);
    expect(await reads(who, id)).toBe(true);
  });

  it("unbinds for the clerk: the column cleared, the portal gone; a second unbind names nobody", async () => {
    const { id, who } = await bound();
    const res = await call(`/api/bindings/brecord/${id}/unbind`, clerk);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ unbound: who });
    expect(await principalOf(id)).toBeNull();
    expect(await reads(who, id)).toBe(false);
    const again = await call(`/api/bindings/brecord/${id}/unbind`, clerk);
    expect(await again.json()).toEqual({ unbound: null });
  });

  it('answers 404 for a type the registry binds nothing on, and the vertical\'s 401 for nobody', async () => {
    expect((await call(`/api/bindings/other/${ulid()}/unbind`, clerk)).status).toBe(404);
    expect((await call(`/api/bindings/brecord/${ulid()}/unbind`)).status).toBe(401);
  });
});
