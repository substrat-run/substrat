import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { manualClock, ulid, type ManualClock } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { MODULES, provisionDashboard, type DashboardNode } from '../src/index.js';
import type { ConnectLinkRow, ConnectLinkConsume } from '../src/module.js';

/**
 * Connect links (#1220) — the DB-backed half of an OAuth-style provider connect.
 *
 * What must hold, and what each test pins: a link is SINGLE-use (the consume's WHERE
 * decides, so two racing callbacks cannot both pass), REVOCABLE while outstanding,
 * and EXPIRING against `ctx.now()` (a manual clock, so the lapse is asserted rather
 * than slept for) — and every verb is the minting admin's own permission-checked act,
 * so a principal without `dashboard:manage-integrations` gets nothing.
 */
describe('dashboard connect links', () => {
  let dir: string;
  let clock: ManualClock;
  let host: SqliteScopeHost;
  let node: DashboardNode;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-connect-links-'));
    clock = manualClock('2026-09-01T09:00:00.000Z');
    host = new SqliteScopeHost({ dir, clock: clock.read });
    for (const m of MODULES) host.registerModule(m);
    node = await provisionDashboard(host, {
      tenantId: tenantId.parse(ulid()),
      scopeId: scopeId.parse(ulid()),
      owner: principalId.parse(ulid()),
      slug: 'acme',
      name: 'Acme',
    });
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const scope = async () => host.getScope(node.principal, node.tenantId, node.scopeId);

  const mint = async (ttlMs?: number): Promise<ConnectLinkRow> =>
    (await scope()).invoke('dashboard/mint-connect-link', {
      provider: 'fortnox',
      appScopeId: 'app-scope-1',
      ...(ttlMs !== undefined ? { ttlMs } : {}),
    });

  const consume = async (linkId: string): Promise<ConnectLinkConsume> =>
    (await scope()).invoke('dashboard/consume-connect-link', {
      linkId,
      provider: 'fortnox',
      accountRef: '123456',
      accountLabel: 'Testbolaget AB',
    });

  const outstanding = async (): Promise<ConnectLinkRow[]> =>
    (await scope()).invoke('dashboard/list-connect-links', { provider: 'fortnox' });

  it('mints outstanding, consumes exactly once, and records what the consent attached', async () => {
    const link = await mint();
    expect(link.status).toBe('outstanding');
    expect((await outstanding()).map((l) => l.id)).toEqual([link.id]);

    const first = await consume(link.id);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.link.status).toBe('used');
      // The audit answer to "who connected THAT company": recorded at consume time.
      expect(first.link.account_ref).toBe('123456');
      expect(first.link.account_label).toBe('Testbolaget AB');
    }

    // The second spend of the same link — a forwarded email, a reloaded callback —
    // answers 'used' and changes nothing.
    expect(await consume(link.id)).toEqual({ ok: false, reason: 'used' });
    expect(await outstanding()).toEqual([]);
  });

  it('a revoked link refuses, and stays revoked', async () => {
    const link = await mint();
    const s = await scope();
    expect(await s.invoke('dashboard/revoke-connect-link', { linkId: link.id })).toEqual({ status: 'revoked' });
    expect(await consume(link.id)).toEqual({ ok: false, reason: 'revoked' });
    // Revoking again (or after use) does not resurrect or error — the status is the answer.
    expect(await s.invoke('dashboard/revoke-connect-link', { linkId: link.id })).toEqual({ status: 'revoked' });
    expect(await outstanding()).toEqual([]);
  });

  it('expires against ctx.now(): the lapse is a clock advance, never a sleep', async () => {
    const link = await mint(60 * 60 * 1000); // one hour
    clock.advance(2 * 60 * 60 * 1000);
    expect(await consume(link.id)).toEqual({ ok: false, reason: 'expired' });
    expect(await outstanding()).toEqual([]);
  });

  it('an unknown link answers unknown — indistinguishable from a foreign tenant’s', async () => {
    expect(await consume(ulid())).toEqual({ ok: false, reason: 'unknown' });
  });

  it('every verb is gated on dashboard:manage-integrations', async () => {
    const stranger = await host.getScope(principalId.parse(ulid()), node.tenantId, node.scopeId);
    await expect(
      stranger.invoke('dashboard/mint-connect-link', { provider: 'fortnox', appScopeId: 'app-scope-1' }),
    ).rejects.toThrow(/permission/i);
    const link = await mint();
    await expect(
      stranger.invoke('dashboard/consume-connect-link', { linkId: link.id, provider: 'fortnox' }),
    ).rejects.toThrow(/permission/i);
    await expect(stranger.invoke('dashboard/revoke-connect-link', { linkId: link.id })).rejects.toThrow(/permission/i);
    await expect(stranger.invoke('dashboard/list-connect-links', {})).rejects.toThrow(/permission/i);
  });
});
