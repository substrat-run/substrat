/**
 * One exchange, one instant (#1672).
 *
 * The shared suite asserts that an exchange's `capability.exercised` event and the row it
 * updated agree about WHEN — but on a real clock two reads inside the same millisecond agree
 * by accident, so that assertion cannot tell one read from two. Here the host's clock moves
 * forward on EVERY read, so a second read is a different instant by construction and the
 * test fails the moment the exchange reads the clock twice. Pure host only: the DO host
 * takes no clock (#956), and the exchange there threads its one instant the same way.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  capabilityRecord,
  instant,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type MintedCapability,
} from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { capMod } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';

describe('an exchange stamps its row and its event with one instant', () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-cap-instant-'));
  let t = Date.parse('2026-03-01T09:00:00.000Z');
  // Every read is a millisecond later than the last.
  const ticking = () => instant.parse(new Date(t++).toISOString());
  const host = new SqliteScopeHost({ dir, clock: ticking });
  const t1 = tenantId.parse(ulid());
  const s1 = scopeId.parse(ulid());
  const alice = principalId.parse(ulid());
  const staff = platformActorId.parse(ulid());
  const READ = permissionKey.parse('cap:read');

  beforeAll(async () => {
    host.registerModule(capMod);
    await host.admin.createTenant(staff, { id: t1, slug: 'cap-instant', name: 'Cap Instant' });
    await host.admin.grantEntitlement(staff, t1, 'cap');
    await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'cap-vertical' });
    await host.admin.activateScope(staff, t1, s1);
    await host.admin.defineRole(staff, t1, { key: 'owner', permissions: [READ], source: 'vertical' });
    await host.admin.assignRole(staff, { principalId: alice, roleKey: 'owner', node: { tenantId: t1, scopeId: null } });
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('`last_used_at` and the exercised event’s `occurredAt` are the same instant, on a clock that never repeats', async () => {
    const stub = await host.getScope(alice, t1, s1);
    const minted = await stub.invoke<MintedCapability>('cap/share', {
      entity: { entityType: 'folder', entityId: 'F' },
      permissions: [READ],
    });
    expect((await host.exchangeCapability(t1, s1, minted.secret))?.kind).toBe('session');
    const events = await stub.invoke<{ type: string; occurred_at: string; payload: string }[]>('cap/outbox');
    const exercised = events.find(
      (e) => e.type === 'capability.exercised' && JSON.parse(e.payload).capabilityId === minted.id,
    )!;
    const record = (await stub.invoke<unknown[]>('cap/list', {}))
      .map((r) => capabilityRecord.parse(r))
      .find((r) => r.id === minted.id)!;
    expect(record.lastUsedAt).toBe(exercised.occurred_at);
  });
});
