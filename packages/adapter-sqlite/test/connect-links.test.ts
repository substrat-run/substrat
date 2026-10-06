import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { manualClock, ulid, type ManualClock } from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

/**
 * The one connect-link case the shared contract suite cannot reach (connections.md §3.5.4):
 * time passing between the spend and its undo. A callback consumes a link, its store fails,
 * and by the time the restore runs the link has lapsed. It must stay spent rather than come
 * back already dead — a restore is the undo of a spend, never an extension of a link's life.
 * Only the pure host takes a clock a test can move, which is why this lives here.
 */
describe('connect links — restore after the link lapsed (sqlite clock)', () => {
  let dir: string;
  let clock: ManualClock;
  let host: SqliteScopeHost;
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-connect-links-clock-'));
    clock = manualClock('2026-10-01T09:00:00.000Z');
    host = new SqliteScopeHost({ dir, clock: clock.read });
    await host.admin.createTenant(staff, { id: t, slug: 'bureau', name: 'Bureau' });
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'bureau-books' });
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('judges expiry against the host clock, and a lapsed spent link is not restored', async () => {
    const link = await host.admin.mintConnectLink(staff, {
      tenantId: t,
      scopeId: s,
      vertical: 'bureau-books',
      provider: 'fortnox',
      createdBy: principalId.parse(ulid()),
      expiresAt: '2026-10-01T10:00:00.000Z',
    });
    const key = { tenantId: t, scopeId: s, id: link.id };
    expect((await host.admin.consumeConnectLink(staff, { ...key, provider: 'fortnox', accountRef: '1' })).ok).toBe(true);
    clock.advance(2 * 60 * 60 * 1000);
    expect(await host.admin.restoreConnectLink(staff, key)).toBe(false);
    expect((await host.admin.getConnectLink(staff, key))?.status).toBe('used');
  });

  it('a link that lapses before it is opened is refused as expired', async () => {
    const link = await host.admin.mintConnectLink(staff, {
      tenantId: t,
      scopeId: s,
      vertical: 'bureau-books',
      provider: 'fortnox',
      createdBy: principalId.parse(ulid()),
      expiresAt: '2026-10-01T10:00:00.000Z',
    });
    const key = { tenantId: t, scopeId: s, id: link.id };
    expect(await host.admin.listConnectLinks(staff, { tenantId: t, scopeId: s, outstandingOnly: true })).toHaveLength(1);
    clock.advance(2 * 60 * 60 * 1000);
    expect(await host.admin.listConnectLinks(staff, { tenantId: t, scopeId: s, outstandingOnly: true })).toEqual([]);
    expect(await host.admin.consumeConnectLink(staff, { ...key, provider: 'fortnox' })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });
});
