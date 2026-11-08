import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@substrat-run/contracts';
import type { ScopeHost } from '@substrat-run/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildHost, seed, type World } from '../src/seed.js';

let dir: string;
let host: ScopeHost;
let world: World;
// Each stub carries the address the issuer verified, as the door hands it to every operation.
const verified = { markus: 'markus@example.com', dana: 'dana@example.com' } as const;
const as = (who: 'markus' | 'dana') =>
  host.getScope(world[who].principal, world.tenant, world.scope, { verifiedEmail: verified[who] });
const mail = async () =>
  (await (host as unknown as { listPlatformRequestHistory(t: string, s: string): Promise<{ kind: string; payload: { to: string; subject: string } }[]> }).listPlatformRequestHistory(world.tenant, world.scope));

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'lists-invite-'));
  host = buildHost(dir);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('inviting someone who has not joined', () => {
  it('sends the email, and the list arrives when they join', async () => {
    world = await seed(host);
    const owner = await as('markus');
    const list = await owner.invoke<{ id: string }>('lists/create-list', { name: 'Holiday' });
    await owner.invoke('lists/add-item', { listId: list.id, text: 'Passports' });

    const sent = await owner.invoke<{ status: string }>('lists/invite', { listId: list.id, email: 'dana@example.com' });
    expect(sent.status).toBe('invited');
    expect((await mail()).map((m) => m.payload.to)).toEqual(['dana@example.com']);

    const dana = await as('dana');
    await expect(dana.invoke('lists/list-items', { listId: list.id })).rejects.toThrow(/permission denied/i);

    await dana.invoke('lists/join', { displayName: 'Dana' });
    await new Promise((r) => setTimeout(r, 200));
    const items = await dana.invoke<Page<{ text: string }>>('lists/list-items', { listId: list.id });
    expect(items.entries.map((i) => i.text)).toEqual(['Passports']);
    const invites = await owner.invoke<Page<unknown>>('lists/list-invites', { listId: list.id });
    expect(invites.entries).toEqual([]);
    const shares = await owner.invoke<Page<{ email: string }>>('lists/list-shares', { listId: list.id });
    expect(shares.entries.map((s) => s.email)).toEqual(['dana@example.com']);
  });
});
