/**
 * Inviting an address that has not joined: the email is queued in the operation, the person is
 * refused until they join, and joining is what turns the invitation into a share. The sign-in
 * case goes through `createApp`, because that is where joining happens for a real person.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPlatformRequest, principalId, type Page, type PrincipalId } from '@substrat-run/contracts';
import type { DevCaller } from '@substrat-run/dev-issuer';
import { ulid, type ScopeHost, type ScopeStub } from '@substrat-run/kernel';
import { createApp } from '../src/app.js';
import { buildHost, grantOwner, seed, type World } from '../src/seed.js';

let dir: string;
let host: ScopeHost;
let world: World;
let ada: ScopeStub;

const scope = () => ({ tenantId: world.tenant, scopeId: world.scope });

/** A member of the workspace who has not joined the app. */
async function member(verifiedEmail: string): Promise<{ id: PrincipalId; stub: ScopeStub }> {
  const id = principalId.parse(ulid());
  await host.admin.assignRole(world.staff, { principalId: id, roleKey: 'member', node: scope() });
  return { id, stub: await host.getScope(id, world.tenant, world.scope, { verifiedEmail }) };
}

const newList = async (name: string) => (await ada.invoke<{ id: string }>('todo/create-list', { name })).id;

const mailTo = async (address: string) =>
  (await host.listPlatformRequestHistory(world.tenant, world.scope))
    .filter(isPlatformRequest)
    .filter((r) => (r.payload as { to?: string }).to === address);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'todo-invite-'));
  host = buildHost(dir);
  world = await seed(host);
  ada = await host.getScope(world.ada.principal, world.tenant, world.scope);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('inviting someone to a list', () => {
  it('emails an address that has not joined, and shares the list when they do', async () => {
    const listId = await newList('Holiday');
    await ada.invoke('todo/add-item', { listId, text: 'Passports' });

    const sent = await ada.invoke<{ status: string }>('todo/invite', { listId, email: 'elin@example.com' });
    expect(sent.status).toBe('invited');
    expect(await mailTo('elin@example.com')).toHaveLength(1);

    const elin = await member('elin@example.com');
    await expect(elin.stub.invoke('todo/list-items', { listId })).rejects.toThrow(/permission denied/i);

    await elin.stub.invoke('todo/join', { displayName: 'Elin' });
    const items = await elin.stub.invoke<Page<{ text: string }>>('todo/list-items', { listId });
    expect(items.entries.map((i) => i.text)).toEqual(['Passports']);
    expect((await ada.invoke<Page<unknown>>('todo/list-invites', { listId })).entries).toEqual([]);
  });

  it('shares at once with someone who has joined, and sends nothing', async () => {
    const listId = await newList('Groceries');
    const sent = await ada.invoke<{ status: string }>('todo/invite', { listId, email: world.bjorn.email });
    expect(sent.status).toBe('shared');
    expect(await mailTo(world.bjorn.email)).toEqual([]);
  });

  it('gives a withdrawn invitation nothing to become', async () => {
    const listId = await newList('Surprise');
    const { id } = await ada.invoke<{ id: string }>('todo/invite', { listId, email: 'noor@example.com' });
    await ada.invoke('todo/cancel-invite', { inviteId: id });

    const noor = await member('noor@example.com');
    await noor.stub.invoke('todo/join', { displayName: 'Noor' });
    await expect(noor.stub.invoke('todo/list-items', { listId })).rejects.toThrow(/permission denied/i);
  });

  it('keeps an invitation to a binned list waiting', async () => {
    const listId = await newList('Binned');
    await ada.invoke('todo/invite', { listId, email: 'sami@example.com' });
    await ada.invoke('todo/trash-list', { listId });

    const sami = await member('sami@example.com');
    await sami.stub.invoke('todo/join', { displayName: 'Sami' });
    await ada.invoke('todo/restore-list', { listId });
    expect((await ada.invoke<Page<unknown>>('todo/list-invites', { listId })).entries).toHaveLength(1);
  });

  it('joins a person when they sign in, with the address the issuer verified', async () => {
    const listId = await newList('Signed in');
    await ada.invoke('todo/invite', { listId, email: 'tove@example.com' });
    const tove = await member('tove@example.com');
    const caller: DevCaller = {
      principal: tove.id,
      tenantId: world.tenant,
      scopeId: world.scope,
      sub: 'dev|tove',
      display: 'Tove',
      email: 'tove@example.com',
      verifiedEmail: 'tove@example.com',
    };
    const app = createApp({
      host,
      login: { handle: async () => new Response(), caller: async () => caller },
      onJoined: (who) => grantOwner(host, world.staff, scope(), who.principal),
    });

    expect((await app.request('/api/me')).status).toBe(200);
    const items = await tove.stub.invoke<Page<unknown>>('todo/list-items', { listId });
    expect(items.entries).toEqual([]);
  });
});
