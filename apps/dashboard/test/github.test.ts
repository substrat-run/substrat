import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { githubConfig, installUrl, installationAccount, listInstallationRepos } from '../src/github.js';

/**
 * The GitHub App boundary (connections.md §3.5.1). The one part that can only fail at
 * runtime is the crypto: a PKCS#8 PEM imported into Web Crypto and used to sign an
 * RS256 App JWT. So this generates a REAL RSA keypair, drives the client with a fake
 * GitHub (the injected `fetchImpl`), and verifies the JWT it produced actually verifies
 * against the public key — proving the PEM import + sign path works, without a network.
 */
describe('GitHub App client', () => {
  // A real 2048-bit RSA key. NOTE: GitHub's App-key download is PKCS#1
  // ("BEGIN RSA PRIVATE KEY"), not PKCS#8 — both formats are covered below.
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const pkcs1Pem = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;

  interface Call {
    url: string;
    method: string;
    authorization: string | null;
  }

  /** A fake GitHub: records each call + its auth header, answers the three endpoints. */
  function fakeGithub() {
    const calls: Call[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, method: init?.method ?? 'GET', authorization: new Headers(init?.headers).get('authorization') });
      const body =
        u.includes('/access_tokens')
          ? { token: 'ghs_installation_token' }
          : /\/app\/installations\/\d+$/.test(u)
            ? { account: { login: 'acme-inc' } }
            : u.includes('/installation/repositories')
              ? { repositories: [{ full_name: 'acme-inc/hr-portal', default_branch: 'main', private: true, updated_at: '2026-07-20T10:00:00Z' }] }
              : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch;
    return { calls, fetchImpl };
  }

  const cfgFor = (fetchImpl: typeof globalThis.fetch) =>
    githubConfig({ GITHUB_APP_ID: '123456', GITHUB_APP_SLUG: 'substrat-import', GITHUB_APP_PRIVATE_KEY: privateKeyPem }, fetchImpl)!;

  /** Verify an RS256 JWT against our public key (the check GitHub itself performs). */
  async function jwtIsValidRs256(jwt: string): Promise<{ ok: boolean; iss: string }> {
    const [h, p, s] = jwt.split('.');
    const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
    const key = await crypto.subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const sig = Uint8Array.from(atob(s!.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, new TextEncoder().encode(`${h}.${p}`));
    const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(p!.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))));
    return { ok, iss: claims.iss };
  }

  it('returns null config when the App secrets are absent', () => {
    expect(githubConfig({})).toBeNull();
    expect(githubConfig({ GITHUB_APP_ID: '1', GITHUB_APP_SLUG: 's' })).toBeNull(); // missing key
  });

  it('builds the install URL with the slug and carries the signed state', () => {
    const cfg = cfgFor(fakeGithub().fetchImpl);
    const url = installUrl(cfg, 'signed.state.token');
    expect(url).toBe('https://github.com/apps/substrat-import/installations/new?state=signed.state.token');
  });

  it('signs a real, verifiable RS256 App JWT to resolve the installation account', async () => {
    const { calls, fetchImpl } = fakeGithub();
    const account = await installationAccount(cfgFor(fetchImpl), '987');
    expect(account).toBe('acme-inc');

    // The call went to the right endpoint as the App (Bearer <jwt>), and that JWT is a
    // genuine RS256 signature over our key with iss = the App id — GitHub would accept it.
    expect(calls[0]!.url).toBe('https://api.github.com/app/installations/987');
    const bearer = calls[0]!.authorization!;
    expect(bearer.startsWith('Bearer ')).toBe(true);
    const verdict = await jwtIsValidRs256(bearer.slice('Bearer '.length));
    expect(verdict.ok).toBe(true);
    expect(verdict.iss).toBe('123456');
  });

  it('accepts a private key stored as a single line with literal \\n escapes', async () => {
    // The Cloudflare-secret failure mode: a multi-line PEM pasted as one line, its
    // newlines encoded as the two characters backslash+n. The client must normalize
    // these or atob chokes on the leftover backslash.
    const singleLinePem = privateKeyPem.replace(/\n/g, '\\n');
    const { calls, fetchImpl } = fakeGithub();
    const cfg = githubConfig(
      { GITHUB_APP_ID: '123456', GITHUB_APP_SLUG: 'substrat-import', GITHUB_APP_PRIVATE_KEY: singleLinePem },
      fetchImpl,
    )!;
    const account = await installationAccount(cfg, '987');
    expect(account).toBe('acme-inc');
    const verdict = await jwtIsValidRs256(calls[0]!.authorization!.slice('Bearer '.length));
    expect(verdict.ok).toBe(true);
  });

  it('accepts a PKCS#1 key exactly as GitHub downloads it (BEGIN RSA PRIVATE KEY)', async () => {
    // The real-world failure mode this guards: the downloaded .private-key.pem pasted
    // straight into the secret. Web Crypto only imports PKCS#8, so the client must
    // wrap the PKCS#1 DER — a raw import would throw DataError on every call.
    const { calls, fetchImpl } = fakeGithub();
    const cfg = githubConfig(
      { GITHUB_APP_ID: '123456', GITHUB_APP_SLUG: 'substrat-import', GITHUB_APP_PRIVATE_KEY: pkcs1Pem },
      fetchImpl,
    )!;
    const account = await installationAccount(cfg, '987');
    expect(account).toBe('acme-inc');
    const verdict = await jwtIsValidRs256(calls[0]!.authorization!.slice('Bearer '.length));
    expect(verdict.ok).toBe(true);
  });

  it('accepts a single-line PKCS#1 key with literal \\n escapes', async () => {
    const { calls, fetchImpl } = fakeGithub();
    const cfg = githubConfig(
      { GITHUB_APP_ID: '123456', GITHUB_APP_SLUG: 'substrat-import', GITHUB_APP_PRIVATE_KEY: pkcs1Pem.replace(/\n/g, '\\n') },
      fetchImpl,
    )!;
    const account = await installationAccount(cfg, '987');
    expect(account).toBe('acme-inc');
    const verdict = await jwtIsValidRs256(calls[0]!.authorization!.slice('Bearer '.length));
    expect(verdict.ok).toBe(true);
  });

  it('mints an installation token, then lists repos with it', async () => {
    const { calls, fetchImpl } = fakeGithub();
    const repos = await listInstallationRepos(cfgFor(fetchImpl), '987');
    expect(repos).toEqual([
      { fullName: 'acme-inc/hr-portal', defaultBranch: 'main', private: true, updatedAt: '2026-07-20T10:00:00Z' },
    ]);

    // First mints a token as the App (Bearer JWT, POST), then lists repos as the
    // installation (token <installation token>). Two distinct credentials, right order.
    const tokenCall = calls.find((c) => c.url.includes('/access_tokens'))!;
    expect(tokenCall.method).toBe('POST');
    expect(tokenCall.authorization!.startsWith('Bearer ')).toBe(true);
    const reposCall = calls.find((c) => c.url.includes('/installation/repositories'))!;
    expect(reposCall.authorization).toBe('token ghs_installation_token');
  });
});
