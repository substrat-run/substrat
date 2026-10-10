import { describe, it, expect } from 'vitest';
import { signConnectState, type ConnectStateClaim } from '@substrat-run/kernel';
import { signClaim, CONNECT_LINK_PURPOSE, GITHUB_STATE_PURPOSE, INVITE_TOKEN_PURPOSE } from '../src/signed-token.js';
import {
  resolveConnectRound,
  connectionScopeOf,
  connectReturn,
  type ConnectLinkClaim,
  type ConnectRound,
} from '../src/connect-round.js';

/**
 * The two doors into one consent flow (connections.md §3.5.3). A **link** round is the
 * dashboard's, backed by a revocable single-use row; a **platform** round is a vertical's,
 * backed by nothing but a short-lived signature. Both end at the same callback, so what
 * has to hold is that the callback can always tell which it is holding — and that neither
 * secret can be made to speak for the other.
 */
describe('connect rounds — telling a dashboard link from a vertical-started round', () => {
  const SESSION_SECRET = 'dashboard-session-secret-32-bytes';
  const PLATFORM_SECRET = 'platform-shared-script-secret-32b';
  const env = { SESSION_SECRET, PLATFORM_SECRET };
  const now = Date.now();

  const linkClaim: ConnectLinkClaim = {
    linkId: 'link-1',
    tenantId: '01J000000000000000000TEN',
    scopeId: '01J0000000000000000DASH', // the tenant's DASHBOARD scope — where the row lives
    appScopeId: '01J00000000000000000APP',
    principal: '01J000000000000000ADMIN',
    provider: 'fortnox',
    exp: now + 60_000,
  };
  const platformClaim: ConnectStateClaim = {
    tenantId: '01J000000000000000000TEN',
    scopeId: '01J00000000000000000APP', // the VERTICAL's own scope
    vertical: 'bureau-books',
    provider: 'fortnox',
    principal: '01J00000000000000BUREAU',
    exp: now + 60_000,
  };

  const linkToken = () => signClaim(SESSION_SECRET, CONNECT_LINK_PURPOSE, linkClaim);
  const platformToken = (over: Partial<ConnectStateClaim> = {}) =>
    signConnectState(PLATFORM_SECRET, { ...platformClaim, ...over });

  it('recognises a dashboard connect link', async () => {
    const round = await resolveConnectRound(env, await linkToken(), now);
    expect(round).toEqual({ kind: 'link', claim: linkClaim });
  });

  it('recognises a vertical-started platform round', async () => {
    const round = await resolveConnectRound(env, await platformToken(), now);
    expect(round?.kind).toBe('platform');
    expect(round?.claim).toMatchObject({ vertical: 'bureau-books', principal: platformClaim.principal });
  });

  // The whole reason the two are separate HMAC families. If either secret could sign for
  // the other, a vertical holding PLATFORM_SECRET could mint a claim naming the dashboard
  // scope — and the callback would run the dashboard's consume path against it.
  it('will not let one secret speak for the other', async () => {
    expect(await resolveConnectRound({ SESSION_SECRET, PLATFORM_SECRET: SESSION_SECRET }, await platformToken(), now)).toBeNull();
    expect(
      await resolveConnectRound({ SESSION_SECRET: PLATFORM_SECRET, PLATFORM_SECRET }, await linkToken(), now),
    ).toBeNull();
  });

  // A deployment that has never been given the platform secret is not thereby broken —
  // it simply recognises no vertical-started rounds. Fails closed, never open.
  it('accepts links but no platform rounds when PLATFORM_SECRET is unset', async () => {
    const bare = { SESSION_SECRET };
    expect(await resolveConnectRound(bare, await linkToken(), now)).toMatchObject({ kind: 'link' });
    expect(await resolveConnectRound(bare, await platformToken(), now)).toBeNull();
  });

  it('refuses a token minted for another purpose under the same session secret', async () => {
    for (const purpose of [GITHUB_STATE_PURPOSE, INVITE_TOKEN_PURPOSE]) {
      const token = await signClaim(SESSION_SECRET, purpose, { ...linkClaim });
      expect(await resolveConnectRound(env, token, now)).toBeNull();
    }
  });

  it.each(['', 'garbage', 'a.b.c'])('refuses the malformed token %j', async (token) => {
    expect(await resolveConnectRound(env, token, now)).toBeNull();
  });

  it('refuses either round once expired', async () => {
    expect(await resolveConnectRound(env, await linkToken(), now + 120_000)).toBeNull();
    expect(await resolveConnectRound(env, await platformToken(), now + 120_000)).toBeNull();
  });

  describe('where the credential lands', () => {
    // A link names the app it was minted FOR; a platform round names the scope that
    // authorized it. Getting this backwards would file a bureau's client credential
    // against the dashboard's own scope, where its vertical could never read it.
    it('a link round lands on the app scope, a platform round on the authorizing scope', async () => {
      expect(connectionScopeOf({ kind: 'link', claim: linkClaim })).toBe(linkClaim.appScopeId);
      expect(connectionScopeOf({ kind: 'platform', claim: platformClaim })).toBe(platformClaim.scopeId);
    });
  });

  describe('where the person goes afterwards', () => {
    const platformRound = (over: Partial<ConnectStateClaim> = {}): ConnectRound => ({
      kind: 'platform',
      claim: { ...platformClaim, ...over },
    });

    it('has nowhere to send a link round — it ends on the platform page', () => {
      expect(connectReturn({ kind: 'link', claim: linkClaim }, { connected: '1' })).toBeNull();
    });

    it('has nowhere to send a platform round that asked for no return', () => {
      expect(connectReturn(platformRound(), { connected: '1' })).toBeNull();
    });

    it('appends the outcome, preserving the deep link the vertical built', () => {
      const back = connectReturn(
        platformRound({ returnUrl: 'https://books.example/clients/42?tab=books' }),
        { connected: '1', account: '123456', company: 'Testbolaget AB' },
      );
      const url = new URL(back!);
      expect(url.origin + url.pathname).toBe('https://books.example/clients/42');
      // The vertical's own query survives — that URL is how it gets the person back
      // to the row they started from.
      expect(url.searchParams.get('tab')).toBe('books');
      expect(url.searchParams.get('connected')).toBe('1');
      expect(url.searchParams.get('account')).toBe('123456');
      expect(url.searchParams.get('company')).toBe('Testbolaget AB');
    });

    it('echoes the subject reference the vertical named, so it can attribute the landing', () => {
      const back = connectReturn(
        platformRound({ returnUrl: 'https://books.example/clients/42', subjectRef: 'client-42' }),
        { connected: '1' },
      );
      expect(new URL(back!).searchParams.get('subjectRef')).toBe('client-42');
    });

    it('carries a refusal back too — a bureau must not be stranded on a dashboard page', () => {
      const back = connectReturn(platformRound({ returnUrl: 'https://books.example/clients/42' }), {
        error: 'declined',
      });
      expect(new URL(back!).searchParams.get('error')).toBe('declined');
      expect(new URL(back!).searchParams.has('connected')).toBe(false);
    });
  });
});
