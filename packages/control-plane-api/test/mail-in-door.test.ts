import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import { platformActorId, scopeId, tenantId, type MailInAddressAct } from '@substrat-run/contracts';
import { createControlPlaneApi, DEV_ACTOR_HEADER, UNSAFE_devPlatformActorAuth, type MailInTenantDoor } from '../src/index.js';

/**
 * `GET`/`POST /tenants/:t/scopes/:s/mail-in` (#2611) — transport over the host-injected mail-in
 * door: the path's tenant and scope go to the door, a malformed act never reaches it, a door
 * refusal under 500 is answered in the door's words, and a deployment with no door says so.
 */
describe('the mail-in tenant door (#2611)', () => {
  const staff = platformActorId.parse(ulid());
  const acme = tenantId.parse(ulid());
  const app = scopeId.parse(ulid());
  const headers = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  let dir: string;
  let host: SqliteScopeHost;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cp-mail-in-door-'));
    host = new SqliteScopeHost({ dir });
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const api = (mailIn?: MailInTenantDoor) => createControlPlaneApi({ host, authenticate: UNSAFE_devPlatformActorAuth(), ...(mailIn ? { mailIn } : {}) });
  const path = `/tenants/${acme}/scopes/${app}/mail-in`;
  const post = (door: MailInTenantDoor | undefined, body: unknown) => api(door).request(path, { method: 'POST', headers, body: JSON.stringify(body) });

  it('hands the door the path’s scope and the parsed act, and answers what it returns', async () => {
    const seen: unknown[] = [];
    const door: MailInTenantDoor = {
      standing: async (_h, scope) => {
        seen.push(scope);
        return { address: null, landing: { operation: 'books/receive-mail', permission: 'books:receive-mail' }, receiving: true };
      },
      act: async (_h, scope, act: MailInAddressAct) => {
        seen.push({ scope, act });
        return null;
      },
    };
    const read = await api(door).request(path, { headers });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ address: null, landing: { operation: 'books/receive-mail', permission: 'books:receive-mail' }, receiving: true });
    const acted = await post(door, { action: 'request', createdBy: 'p-1', allowlist: [' Me@Owner.example '] });
    expect(await acted.json()).toEqual({ address: null });
    expect(seen).toEqual([
      { tenantId: acme, scopeId: app },
      { scope: { tenantId: acme, scopeId: app }, act: { action: 'request', createdBy: 'p-1', allowlist: ['me@owner.example'] } },
    ]);
  });

  it('refuses a malformed act without asking the door, and answers 501 with no door', async () => {
    let asked = 0;
    const door: MailInTenantDoor = {
      standing: async () => {
        asked += 1;
        throw new Error('not asked');
      },
      act: async () => {
        asked += 1;
        return null;
      },
    };
    for (const body of [{ action: 'request' }, { action: 'delete', createdBy: 'p-1' }, { action: 'request', createdBy: 'p-1', allowlist: ['not an address'] }]) {
      expect((await post(door, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(asked).toBe(0);
    expect((await api().request(path, { headers })).status).toBe(501);
    expect((await post(undefined, { action: 'revoke', createdBy: 'p-1' })).status).toBe(501);
  });

  it('answers a door refusal in its own words, and leaves a platform failure to the boundary', async () => {
    const refusing = (status: number, code?: string): MailInTenantDoor => ({
      standing: async () => {
        throw Object.assign(new Error('scope not found'), { status, ...(code ? { code } : {}) });
      },
      act: async () => {
        throw Object.assign(new Error("vertical 'acme/books' declares no mail-in landing"), { status, ...(code ? { code } : {}) });
      },
    });
    const notFound = await api(refusing(404, 'not_found')).request(path, { headers });
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toMatchObject({ detail: 'scope not found' });
    const conflict = await post(refusing(409, 'conflict'), { action: 'request', createdBy: 'p-1' });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ detail: expect.stringContaining('declares no mail-in landing') });
    // A deployment that receives no mail: the boundary answers it as `unavailable`, in its words.
    const unwired = await post(refusing(503, 'unavailable'), { action: 'request', createdBy: 'p-1' });
    expect(unwired.status).toBe(503);
    expect(await unwired.json()).toMatchObject({ detail: expect.stringContaining('declares no mail-in landing') });
  });
});
