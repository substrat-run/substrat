/**
 * Todo as the app that owns the people (`identity.person@1`): who may decide plugin access,
 * and that the question a plugin asks is answerable by a plugin alone.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scopeId, type PersonResolveOutput } from '@substrat-run/contracts';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import { buildHost, seed, type World } from '../src/seed.js';

let dir: string;
let host: SqliteScopeHost;
let world: World;

const as = (who: World['ada']) => host.getScope(who.principal, world.tenant, world.scope);
/** The peer door, as the `notes` plugin: the caller Todo's manifest allowlists. */
const asNotes = () => host.getVerticalScope({ vertical: 'notes', scope: scopeId.parse(ulid()) }, world.tenant, world.scope);
const resolve = async (verifiedEmail: string | null) =>
  (await asNotes()).invoke<PersonResolveOutput, unknown>('todo/resolve-person', { issuer: null, sub: 'any', verifiedEmail });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'todo-plugin-access-'));
  host = buildHost(dir);
  world = await seed(host);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('plugin access', () => {
  it('a plugin is answered a member by the address they joined with: known, and holding what they were given', async () => {
    const id = world.bjorn.principal;
    expect(await resolve(world.bjorn.email)).toEqual({ person: { id, status: 'active', roles: [] } });

    await (await as(world.ada)).invoke('todo/grant-plugin-access', { memberId: id });
    expect(await resolve(world.bjorn.email)).toEqual({ person: { id, status: 'active', roles: ['member'] } });

    await (await as(world.ada)).invoke('todo/revoke-plugin-access', { memberId: id });
    expect(await resolve(world.bjorn.email)).toEqual({ person: { id, status: 'active', roles: [] } });
  });

  it.each([
    ['an address nobody joined with', 'nobody@example.com'],
    ['a login with no verified address', null],
  ])('a plugin is answered nobody for %s', async (_name, email) => {
    expect(await resolve(email)).toEqual({ person: null });
  });

  it('an admin sees each member with whether they may use plugins; a member is refused the read', async () => {
    await (await as(world.ada)).invoke('todo/grant-plugin-access', { memberId: world.ada.principal });
    const page = await (await as(world.ada)).invoke<{ entries: { id: string; plugin_access: boolean }[] }, unknown>('todo/list-members', {});
    expect(Object.fromEntries(page.entries.map((m) => [m.id, m.plugin_access]))).toMatchObject({
      [world.ada.principal]: true,
      [world.bjorn.principal]: false,
    });
    await expect((await as(world.bjorn)).invoke('todo/list-members', {})).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('only an admin decides plugin access', async () => {
    await expect((await as(world.bjorn)).invoke('todo/grant-plugin-access', { memberId: world.bjorn.principal })).rejects.toMatchObject({
      code: 'permission_denied',
    });
  });

  it('no person can ask who a login is, an admin included', async () => {
    await expect(
      (await as(world.ada)).invoke('todo/resolve-person', { issuer: null, sub: 'any', verifiedEmail: world.bjorn.email }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });
});
