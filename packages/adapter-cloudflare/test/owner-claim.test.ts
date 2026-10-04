/**
 * The owner claim link as a `become` capability (#1686), over the two producers a deployed
 * vertical runs: a real CP-less `CloudflareScopeHost` (the capability's ScopeDO) and vertical-auth's
 * real `IdentityDO` (which capability is the current link), with vertical-auth's one redeem mount
 * in front. The directory's rules are held in node by `packages/vertical-auth/test/owner-seat.test.ts`;
 * what only this harness can show is the exchange — expiry, single use and revocation judged in
 * the scope's own storage on workerd — and that the two halves agree.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  capabilityId,
  instant,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type CapabilityRecord,
} from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { OWNER_CLAIM_LABEL, OWNER_CLAIM_TTL_MS, mintOwnerClaimLink, sha256Hex } from '@substrat-run/vertical-auth';
import { mountOwnerClaim } from '@substrat-run/vertical-auth/owner-claim-routes';
import { CloudflareScopeHost } from '../src/host.js';

const ORIGIN = 'https://desk.example.test';

describe('owner claim link as a become capability (#1686)', () => {
  let host: CloudflareScopeHost;
  let app: Hono<{ Bindings: Record<string, never> }>;
  let t: ReturnType<typeof tenantId.parse>;
  let s: ReturnType<typeof scopeId.parse>;
  let owner: ReturnType<typeof principalId.parse>;
  const actor = platformActorId.parse(ulid());
  const READ = permissionKey.parse('perm:read');

  const identity = () => env.AUTH.get(env.AUTH.idFromName(t));
  const mint = () => mintOwnerClaimLink({ directory: identity(), host }, { tenantId: t, scopeId: s }, ORIGIN, actor);
  const secretOf = (claimUrl: string) => new URL(claimUrl).searchParams.get('claim')!;
  const redeem = (token: string, sub: string | null = 'sub-installer') =>
    app.request('/api/claim-owner', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(sub ? { 'x-test-sub': sub } : {}) },
      body: JSON.stringify({ token }),
    });
  const capabilities = async (): Promise<CapabilityRecord[]> =>
    (await host.listCapabilitiesLocal(s, { includeRevoked: true })).entries;
  const record = async (id: string) => (await capabilities()).find((r) => r.id === id)!;

  beforeAll(() => {
    host = new CloudflareScopeHost({ scope: env.SCOPE, secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)) });
    app = new Hono();
    mountOwnerClaim(app, {
      nodeFor: () => ({ tenantId: t, scopeId: s }),
      authProvider: async () => ({
        handle: async () => new Response(null, { status: 404 }),
        resolve: async (headers) => {
          const sub = headers.get('x-test-sub');
          return sub ? { sub, email: null, name: null } : null;
        },
      }),
      directory: () => identity(),
      host: () => host,
    });
    app.onError((err, c) =>
      err instanceof HTTPException ? c.json({ error: err.message }, err.status) : c.json({ error: String(err) }, 500),
    );
  });

  afterAll(async () => host.close());

  // A fresh tenant and scope per case: the seat is single-use by design.
  beforeEach(async () => {
    t = tenantId.parse(ulid());
    s = scopeId.parse(ulid());
    owner = principalId.parse(ulid());
    await host.provisionScopeLocal({
      tenantId: t,
      scopeId: s,
      owner,
      roles: [{ key: 'owner', permissions: [READ], source: 'vertical' }],
      ownerRoleKey: 'owner',
    });
    await identity().setPendingOwner(s, owner);
  });

  it('mints a single-use, expiring become capability for the pending owner, and the link binds once', async () => {
    const before = Date.now();
    const link = await mint();
    expect(link).not.toBeNull();
    expect(link!.claimUrl.startsWith(`${ORIGIN}/?claim=sbcap_`)).toBe(true);
    const [cap] = await capabilities();
    expect(cap).toMatchObject({
      mode: 'become',
      principal: owner,
      maxUses: 1,
      uses: 0,
      label: OWNER_CLAIM_LABEL,
      mintedBy: { platform: actor },
      revokedAt: null,
      expiresAt: link!.expiresAt,
    });
    const ttl = Date.parse(link!.expiresAt) - before;
    expect(ttl).toBeGreaterThan(OWNER_CLAIM_TTL_MS - 60_000);
    expect(ttl).toBeLessThanOrEqual(OWNER_CLAIM_TTL_MS + 1_000);
    expect(await identity().ownerSeat(s)).toMatchObject({ state: 'unclaimed', claimLink: { expiresAt: link!.expiresAt } });

    // Signed out: refused before anything is read, and the use is not spent.
    expect((await redeem(secretOf(link!.claimUrl), null)).status).toBe(401);
    expect((await record(cap!.id)).uses).toBe(0);

    const ok = await redeem(secretOf(link!.claimUrl));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, principal: owner });
    expect((await record(cap!.id)).uses).toBe(1);
    expect(await identity().ownerSeat(s)).toMatchObject({ state: 'claimed', claimLink: null });
    expect(await identity().resolvePrincipal(s, 'sub-installer')).toBe(owner);

    // Replayed — by anyone: the one refusal, and nobody else is bound.
    const replay = await redeem(secretOf(link!.claimUrl), 'sub-stranger');
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: 'this claim link is invalid, expired, or already used' });
    expect(await identity().resolvePrincipal(s, 'sub-stranger')).toBeNull();
    // And a claimed seat mints nothing.
    expect(await mint()).toBeNull();
    expect(await capabilities()).toHaveLength(1);
  });

  it('a re-mint revokes the previous capability, which is refused — and the new link binds', async () => {
    const first = (await mint())!;
    const second = (await mint())!;
    const [newer, older] = await capabilities();
    expect(older!.revokedAt).not.toBeNull();
    expect(older!.revokedBy).toEqual({ platform: actor });
    expect(newer!.revokedAt).toBeNull();

    expect((await redeem(secretOf(first.claimUrl))).status).toBe(400);
    expect((await record(older!.id)).uses).toBe(0);
    expect(await identity().needsSetup(s)).toBe(true);

    expect((await redeem(secretOf(second.claimUrl))).status).toBe(200);
  });

  it('a link past its expiry is refused by the scope, and binds nobody', async () => {
    const principal = (await identity().ownerClaimTarget(s))!;
    // Minted the way `mintOwnerClaimLink` does, with an expiry the test can wait out.
    const minted = await host.mintCapabilityLocal(
      t,
      s,
      { principal: principalId.parse(principal), expiresAt: instant.parse(new Date(Date.now() + 400).toISOString()), maxUses: 1 },
      actor,
    );
    // Recorded with a LATER expiry than the capability's, so the directory still matches it and
    // the refusal is the scope's own: the capability's expiry is what decides.
    await identity().recordOwnerClaim(s, principal, {
      capabilityId: minted.id,
      tokenHash: await sha256Hex(minted.secret),
      expiresAt: Date.now() + OWNER_CLAIM_TTL_MS,
    });
    await new Promise((r) => setTimeout(r, 600));
    expect((await redeem(minted.secret)).status).toBe(400);
    expect((await record(minted.id)).uses).toBe(0);
    expect(await identity().needsSetup(s)).toBe(true);
  });

  it('a revoked link is refused by the scope even while the directory still names it', async () => {
    const link = (await mint())!;
    const [cap] = await capabilities();
    expect(await host.revokeCapabilityLocal(s, capabilityId.parse(cap!.id), actor)).toBe(true);
    expect((await redeem(secretOf(link.claimUrl))).status).toBe(400);
    expect(await identity().needsSetup(s)).toBe(true);
    // Idempotent, and false for a capability the scope never held.
    expect(await host.revokeCapabilityLocal(s, capabilityId.parse(cap!.id), actor)).toBe(true);
    expect(await host.revokeCapabilityLocal(s, capabilityId.parse(ulid()), actor)).toBe(false);
  });

  it('a become secret that is not the current link is refused WITHOUT spending its use', async () => {
    await mint();
    const stray = await host.mintCapabilityLocal(
      t,
      s,
      { principal: owner, expiresAt: instant.parse(new Date(Date.now() + OWNER_CLAIM_TTL_MS).toISOString()), maxUses: 1 },
      actor,
    );
    expect((await redeem(stray.secret)).status).toBe(400);
    expect((await record(stray.id)).uses).toBe(0);
    expect(await identity().needsSetup(s)).toBe(true);
  });

  it('a LEGACY link (minted before #1686) still binds while it lives — and not after a capability re-mint', async () => {
    const legacy = 'f'.repeat(64);
    const writeLegacy = async () =>
      runInDurableObject(identity(), async (_, state) => {
        state.storage.sql.exec(
          'INSERT OR REPLACE INTO owner_claim (scope_id, token_hash, expires_at) VALUES (?, ?, ?)',
          s,
          await sha256Hex(legacy),
          Date.now() + OWNER_CLAIM_TTL_MS,
        );
      });

    await writeLegacy();
    await mint();
    expect((await redeem(legacy)).status).toBe(400);
    expect(await identity().needsSetup(s)).toBe(true);

    // The twin, on a seat with no capability mint since: the legacy link binds.
    t = tenantId.parse(ulid());
    s = scopeId.parse(ulid());
    await identity().setPendingOwner(s, owner);
    await writeLegacy();
    expect(await identity().ownerSeat(s)).toMatchObject({ state: 'unclaimed', claimLink: { expiresAt: expect.any(String) } });
    const ok = await redeem(legacy);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, principal: owner });
  });

  it('a seat already claimed when the mint lands records nothing and revokes the capability it minted', async () => {
    // The first-sign-in window is open (setPendingOwner just ran), so a plain sign-in claims.
    expect(await identity().resolvePrincipal(s, 'sub-early')).toBe(owner);
    expect(await mint()).toBeNull();
    expect(await capabilities()).toHaveLength(0);

    // The race itself: the directory refuses the record, so the helper revokes what it minted.
    const racing = principalId.parse(ulid());
    const t2 = tenantId.parse(ulid());
    const s2 = scopeId.parse(ulid());
    await host.provisionScopeLocal({
      tenantId: t2,
      scopeId: s2,
      owner: racing,
      roles: [{ key: 'owner', permissions: [READ], source: 'vertical' }],
      ownerRoleKey: 'owner',
    });
    const directory = env.AUTH.get(env.AUTH.idFromName(t2));
    await directory.setPendingOwner(s2, racing);
    const raced = await mintOwnerClaimLink(
      {
        directory: {
          ownerClaimTarget: (scope) => directory.ownerClaimTarget(scope),
          recordOwnerClaim: async (scope, principal, row) => {
            await directory.resolvePrincipal(scope, 'sub-racer'); // claims inside the window
            return directory.recordOwnerClaim(scope, principal, row);
          },
        },
        host,
      },
      { tenantId: t2, scopeId: s2 },
      ORIGIN,
      actor,
    );
    expect(raced).toBeNull();
    const [orphan] = (await host.listCapabilitiesLocal(s2, { includeRevoked: true })).entries;
    expect(orphan!.revokedAt).not.toBeNull();
  });
});
