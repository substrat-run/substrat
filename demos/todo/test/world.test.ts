/**
 * The cast is seated by the kernel's `seatWorld` from `personas.ts` alone (#3108): each persona
 * in its own tenant, and the same principal on every boot. The dev server re-seats on each
 * boot, so a persona added after the first one is seated then — with its role, which is what
 * the hand-written persona table this replaced could skip without a word.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seatWorld, type ScopeHost } from '@substrat-run/kernel';
import { DEV_PROVIDER } from '../src/personas.js';
import { buildHost, linkDevPersonas, seed, type World } from '../src/seed.js';
import { WORLD } from '../src/world.js';

let dir: string;
let host: ScopeHost;
let world: World;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'todo-world-'));
  host = buildHost(dir);
  world = await seed(host);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const who = async (tenant: World['tenant'], sub: string) =>
  (await host.admin.resolveIdentity(tenant, DEV_PROVIDER, sub))?.principal;

describe("todo's seated world", () => {
  it('seats each persona in its own tenant only, and a re-seat keeps every principal', async () => {
    await linkDevPersonas(host, world);
    expect(await who(world.tenant, 'dev|ada')).toBe(world.ada.principal);
    expect(await who(world.tenant, 'dev|bjorn')).toBe(world.bjorn.principal);
    expect(await who(world.otherTenant, 'dev|cleo')).toBe(world.cleo.principal);
    expect(await who(world.tenant, 'dev|cleo')).toBeUndefined();
    expect(await who(world.otherTenant, 'dev|ada')).toBeUndefined();
  });

  it('seats a persona added after the first boot, with its role', async () => {
    const dana = { sub: 'dev|dana', name: 'Dana', email: 'dana@example.com', role: 'member' };
    await seatWorld(host, {
      actor: world.staff,
      node: { tenantId: world.tenant, scopeId: world.scope },
      provider: DEV_PROVIDER,
      world: { ...WORLD, personas: [...WORLD.personas, dana] },
    });
    const principal = await who(world.tenant, dana.sub);
    expect(principal).toBeDefined();
    expect(await host.listScopeRoleHolders(world.tenant, world.scope, principal)).toEqual([{ principal, roleKey: 'member' }]);
  });
});
