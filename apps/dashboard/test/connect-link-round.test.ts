import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import {
  createControlPlaneApi,
  mintTenantToken,
  relayConnectLinkMint,
  relayConnectLinkRevoke,
  tenantTokenAuth,
} from '@substrat-run/control-plane-api';
import { platformActorId, principalId, scopeId, tenantId, type TenantId } from '@substrat-run/contracts';
import { signConnectState, ulid } from '@substrat-run/kernel';
import { TenantNarrowedControlPlane } from '../src/authority.js';
import {
  connectReturn,
  linkRefusalAtLanding,
  linkSenderOf,
  platformLinkRow,
  resolveConnectRound,
  settleConsent,
  type ConnectRound,
} from '../src/connect-round.js';

/**
 * A vertical's MAILED connect link at the dashboard's two doors (connections.md §3.5.4).
 *
 * A bureau mints the link from its vertical and mails it to a client company's Fortnox
 * administrator; days later that person lands on the dashboard's consent start, and the
 * provider sends them back to its callback. What must hold there is what makes a link worth
 * mailing: the landing ASKS the row and spends nothing (a mail scanner must not burn it), the
 * callback spends it before storing so exactly one round connects, a revoked link stops at
 * the landing, and a failed store gives the link back.
 *
 * The plane is real — `createControlPlaneApi` over a SQLite host, reached through the
 * dashboard's own tenant-narrowed authority with a tenant token — so the row is the one the
 * relay wrote, and the routes are the ones the dashboard's credential actually reaches.
 */
describe('a vertical-minted connect link at the landing and the callback', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const other = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const sibling = scopeId.parse(ulid());
  const bureauAdmin = principalId.parse(ulid());
  const PLATFORM_SECRET = 'platform-secret-value-32-bytes-min';
  const env = { SESSION_SECRET: 'dashboard-session-secret-32-bytes', PLATFORM_SECRET };
  const relayOptions = {
    connectOrigin: 'https://app.substrat.net',
    platformSecret: PLATFORM_SECRET,
    flows: { fortnox: { startPath: '/api/integrations/fortnox/connect' } },
  };
  const TENANT_TOKEN_SECRET = 'connect-link-round-tenant-token-secret';
  const account = { accountRef: '123456', accountLabel: 'Testbolaget AB' };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-connect-link-round-'));
    host = new SqliteScopeHost({ dir });
    await host.admin.createTenant(staff, { id: t, slug: 'bureau', name: 'Bureau' });
    await host.admin.createTenant(staff, { id: other, slug: 'other', name: 'Other' });
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'bureau-books' });
    await host.provisionScope(staff, { tenantId: t, scopeId: sibling, vertical: 'bureau-books' });
    await host.admin.bindHostname(staff, {
      hostname: 'books.bureau.example',
      tenantId: t,
      scopeId: s,
      surface: 'app',
      region: null,
      canonical: true,
    });
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** The dashboard's authority for one tenant, over the real plane, as production wires it. */
  const planeFor = (tenant: TenantId): TenantNarrowedControlPlane => {
    const plane = createControlPlaneApi({
      host,
      authenticate: () => null,
      authenticateTenantService: tenantTokenAuth(TENANT_TOKEN_SECRET, staff),
    });
    return new TenantNarrowedControlPlane({
      baseUrl: 'http://cp',
      credential: () => mintTenantToken(TENANT_TOKEN_SECRET, { tenantId: tenant }),
      tenantId: tenant,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const u = new URL(String(url));
        return plane.request(u.pathname + u.search, init);
      }) as typeof globalThis.fetch,
    });
  };

  /** Mint as the vertical's harness would, and resolve the token as the landing does. */
  const mintRound = async (over: Record<string, unknown> = {}): Promise<ConnectRound> => {
    const minted = await relayConnectLinkMint(
      host,
      staff,
      { tenantId: t, scopeId: s, provider: 'fortnox', createdBy: bureauAdmin, ...over },
      relayOptions,
    );
    const round = await resolveConnectRound(env, new URL(minted.url).searchParams.get('token')!, Date.now());
    expect(round?.kind).toBe('platform');
    return round!;
  };
  const rowOf = (round: ConnectRound, nowMs: () => number = Date.now) => platformLinkRow(round, () => planeFor(t), nowMs);
  const linkIdOf = (round: ConnectRound) => (round.kind === 'platform' ? round.claim.linkId! : '');
  const stored = () => {
    const calls: number[] = [];
    return { calls, store: async () => void calls.push(1) };
  };

  it('is recognised as a platform round naming its row, sent by someone other than a Substrat admin', async () => {
    const round = await mintRound({ returnUrl: 'https://books.bureau.example/clients/42', subjectRef: 'client-42' });
    expect(linkIdOf(round)).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(linkSenderOf(round)).toBe('sender');
    const back = new URL(connectReturn(round, { connected: '1' })!);
    expect(back.searchParams.get('link')).toBe(linkIdOf(round));
    expect(back.searchParams.get('subjectRef')).toBe('client-42');
    // An in-session round has no row: nothing to ask, nothing to spend.
    const inSession: ConnectRound = { kind: 'platform', claim: { ...round.claim, linkId: undefined } as never };
    expect(platformLinkRow(inSession, () => planeFor(t), Date.now)).toBeNull();
    expect(linkSenderOf(inSession)).toBe('dashboard');
  });

  it('the landing asks and spends nothing — a mail scanner opening it twice leaves it outstanding', async () => {
    const round = await mintRound();
    expect(await linkRefusalAtLanding(rowOf(round))).toBeNull();
    expect(await linkRefusalAtLanding(rowOf(round))).toBeNull();
    const link = await host.admin.getConnectLink(staff, { tenantId: t, scopeId: s, id: linkIdOf(round) });
    expect(link?.status).toBe('outstanding');
  });

  it('the callback spends the link before storing — the second round is refused and stores nothing', async () => {
    const round = await mintRound();
    const first = stored();
    expect(await settleConsent(rowOf(round), account, first.store)).toEqual({ ok: true });
    expect(first.calls).toHaveLength(1);
    expect(await host.admin.getConnectLink(staff, { tenantId: t, scopeId: s, id: linkIdOf(round) })).toMatchObject({
      status: 'used',
      accountRef: '123456',
      accountLabel: 'Testbolaget AB',
    });

    const second = stored();
    expect(await settleConsent(rowOf(round), account, second.store)).toEqual({ ok: false, at: 'consume', reason: 'used' });
    expect(second.calls).toEqual([]);
    expect(await linkRefusalAtLanding(rowOf(round))).toBe('used');
  });

  it('two racing callbacks for one link store exactly once', async () => {
    const round = await mintRound();
    const s1 = stored();
    const results = await Promise.all([
      settleConsent(rowOf(round), account, s1.store),
      settleConsent(rowOf(round), account, s1.store),
    ]);
    expect(s1.calls).toHaveLength(1);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it('a revoked link is refused at the landing, and at the callback reaches no store', async () => {
    const round = await mintRound();
    await relayConnectLinkRevoke(host, staff, { tenantId: t, scopeId: s, linkId: linkIdOf(round) });
    expect(await linkRefusalAtLanding(rowOf(round))).toBe('revoked');
    const attempt = stored();
    expect(await settleConsent(rowOf(round), account, attempt.store)).toEqual({ ok: false, at: 'consume', reason: 'revoked' });
    expect(attempt.calls).toEqual([]);
  });

  it('a failed store gives the link back, so the same link can carry the retry', async () => {
    const round = await mintRound();
    const failed = await settleConsent(rowOf(round), account, async () => {
      throw new Error('store down');
    });
    expect(failed).toMatchObject({ ok: false, at: 'store', restored: true });
    expect(await linkRefusalAtLanding(rowOf(round))).toBeNull();
    const retry = stored();
    expect(await settleConsent(rowOf(round), account, retry.store)).toEqual({ ok: true });
    expect(retry.calls).toHaveLength(1);
  });

  it('judges the row\'s expiry at the landing, not only the signature\'s', async () => {
    const round = await mintRound({ ttlSeconds: 3600 });
    expect(await linkRefusalAtLanding(rowOf(round, () => Date.now() + 2 * 3600_000))).toBe('expired');
  });

  it('a claim naming another scope\'s link — or read through another tenant\'s credential — finds nothing', async () => {
    const round = await mintRound();
    if (round.kind !== 'platform') throw new Error('unreachable');
    // Even a validly signed claim cannot borrow a row by naming its id under a sibling scope.
    const token = await signConnectState(PLATFORM_SECRET, { ...round.claim, scopeId: sibling });
    const borrowed = (await resolveConnectRound(env, token, Date.now()))!;
    expect(await linkRefusalAtLanding(rowOf(borrowed))).toBe('unknown');
    const spend = stored();
    expect(await settleConsent(rowOf(borrowed), account, spend.store)).toEqual({ ok: false, at: 'consume', reason: 'unknown' });
    expect(spend.calls).toEqual([]);
    // Another tenant's dashboard credential reads the same id as absent.
    expect(await planeFor(other).getConnectLink(s, linkIdOf(round))).toBeUndefined();
    // …and none of that touched the real row.
    expect(await linkRefusalAtLanding(rowOf(round))).toBeNull();
  });

  it('a plane that cannot be reached refuses the landing rather than waving the round through', async () => {
    const round = await mintRound();
    const down = platformLinkRow(
      round,
      () => {
        throw new Error('control plane unreachable');
      },
      Date.now,
    );
    expect(await linkRefusalAtLanding(down)).toBe('unknown');
    const attempt = stored();
    expect(await settleConsent(down, account, attempt.store)).toEqual({ ok: false, at: 'consume', reason: 'unknown' });
    expect(attempt.calls).toEqual([]);
  });

  it('the dashboard lists and revokes an app-minted link through its own credential', async () => {
    const round = await mintRound();
    const cp = planeFor(t);
    expect((await cp.listConnectLinks(s, { provider: 'fortnox', outstanding: true })).map((l) => l.id)).toEqual([
      linkIdOf(round),
    ]);
    expect(await cp.revokeConnectLink(sibling, linkIdOf(round))).toBe(false);
    expect(await cp.revokeConnectLink(s, linkIdOf(round))).toBe(true);
    expect(await cp.listConnectLinks(s, { outstanding: true })).toEqual([]);
    expect(await linkRefusalAtLanding(rowOf(round))).toBe('revoked');
  });
});
