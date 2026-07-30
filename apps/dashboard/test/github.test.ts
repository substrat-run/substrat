import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import nacl from 'tweetnacl';
import { blake2b } from '@noble/hashes/blake2b';
import { deployWorkflowYaml, githubConfig, installUrl, installationAccount, listInstallationRepos, listRepoBranches, setupRepoCi } from '../src/github.js';
import { sealForGithub } from '../src/github-seal.js';

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
              : /\/repos\/[^/]+\/[^/]+\/branches/.test(u)
                ? [{ name: 'main' }, { name: 'develop' }]
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

  it('lists a repo’s branches with the installation token', async () => {
    const { calls, fetchImpl } = fakeGithub();
    const branches = await listRepoBranches(cfgFor(fetchImpl), '987', 'acme-inc/hr-portal');
    expect(branches).toEqual([{ name: 'main' }, { name: 'develop' }]);
    const call = calls.find((c) => c.url.includes('/branches'))!;
    expect(call.url).toContain('/repos/acme-inc/hr-portal/branches');
    expect(call.authorization).toBe('token ghs_installation_token');
  });

  describe('one-click CI setup (setupRepoCi)', () => {
    // A real X25519 repo key, exactly as GitHub's actions/secrets/public-key serves one —
    // so the test can DECRYPT what the client sealed and prove GitHub could too.
    const repoKey = nacl.box.keyPair();
    const repoKeyB64 = Buffer.from(repoKey.publicKey).toString('base64');

    interface WriteCall {
      url: string;
      method: string;
      body?: unknown;
    }

    /** A fake GitHub for the CI-setup flow. `existingSha` simulates an already-present workflow. */
    function fakeCiGithub(opts: { existingSha?: string; secretStatus?: number; keyStatus?: number } = {}) {
      const writes: WriteCall[] = [];
      const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        const method = init?.method ?? 'GET';
        if (method !== 'GET' && u.includes('/repos/')) {
          writes.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        }
        if (u.includes('/access_tokens')) return json({ token: 'ghs_installation_token' });
        if (u.includes('/actions/secrets/public-key')) {
          return json({ key: repoKeyB64, key_id: 'key-1' }, opts.keyStatus ?? 200);
        }
        if (u.includes('/actions/secrets/')) return json({}, opts.secretStatus ?? 201);
        if (u.includes('/contents/') && method === 'GET') {
          return json(opts.existingSha ? { sha: opts.existingSha } : { message: 'Not Found' }, opts.existingSha ? 200 : 404);
        }
        if (u.includes('/contents/') && method === 'PUT') return json({ content: {} }, 201);
        return json({});
      }) as unknown as typeof globalThis.fetch;
      return { writes, fetchImpl };
    }

    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    const input = {
      repoFullName: 'acme-inc/hr-portal',
      branch: 'main',
      workflowPath: '.github/workflows/substrat-deploy.yml',
      workflowContent: 'name: Deploy\n',
      secretName: 'SUBSTRAT_SERVICE_TOKEN',
      secretValue: 'spt1.payload.sig',
      seal: sealForGithub,
    };

    it('writes the sealed secret first, then commits the workflow — and the seal decrypts', async () => {
      const { writes, fetchImpl } = fakeCiGithub();
      const result = await setupRepoCi(cfgFor(fetchImpl), '987', input);
      expect(result).toEqual({ workflowUpdated: false });

      // Order: secret BEFORE workflow (the commit triggers the first CI run).
      expect(writes.map((w) => w.url.split('/repos/')[1])).toEqual([
        'acme-inc/hr-portal/actions/secrets/SUBSTRAT_SERVICE_TOKEN',
        'acme-inc/hr-portal/contents/.github/workflows/substrat-deploy.yml',
      ]);

      // The secret is a genuine libsodium sealed box for the repo key: opening it with
      // the repo's secret key (what GitHub does server-side) yields the token verbatim.
      const secretBody = writes[0]!.body as { encrypted_value: string; key_id: string };
      expect(secretBody.key_id).toBe('key-1');
      const sealed = Uint8Array.from(Buffer.from(secretBody.encrypted_value, 'base64'));
      const epk = sealed.slice(0, 32);
      const nonce = blake2b.create({ dkLen: 24 }).update(epk).update(repoKey.publicKey).digest();
      const opened = nacl.box.open(sealed.slice(32), nonce, epk, repoKey.secretKey);
      expect(opened).not.toBeNull();
      expect(new TextDecoder().decode(opened!)).toBe('spt1.payload.sig');

      // The workflow commit: new file (no sha), right branch, content round-trips.
      const wf = writes[1]!.body as { content: string; branch: string; sha?: string; message: string };
      expect(wf.branch).toBe('main');
      expect(wf.sha).toBeUndefined();
      expect(Buffer.from(wf.content, 'base64').toString()).toBe('name: Deploy\n');
    });

    it('updates an existing workflow via its blob sha', async () => {
      const { writes, fetchImpl } = fakeCiGithub({ existingSha: 'abc123' });
      const result = await setupRepoCi(cfgFor(fetchImpl), '987', input);
      expect(result).toEqual({ workflowUpdated: true });
      const wf = writes[1]!.body as { sha?: string };
      expect(wf.sha).toBe('abc123');
    });

    it('generates a workflow that installs dependencies before the push', () => {
      const yaml = deployWorkflowYaml('main', 'hr-portal', 'https://console.example/api');
      // `substrat push` runs the repo's own build (wrangler custom build), so the
      // repo's devDependencies must be on disk before the push step — regression
      // guard: the first generated workflow had no install step at all.
      const install = yaml.indexOf('pnpm install --frozen-lockfile');
      const push = yaml.indexOf('npx @substrat-run/cli push . --slug hr-portal --version 0.1.${{ github.run_number }}');
      expect(install).toBeGreaterThan(-1);
      expect(push).toBeGreaterThan(install);
      // Every common lockfile has a branch; bare repos fall back to npm install.
      for (const line of ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'else npm install']) {
        expect(yaml).toContain(line);
      }
      expect(yaml).toContain('branches: [main]');
      expect(yaml).toContain('SUBSTRAT_CP_URL: https://console.example/api');
      expect(yaml).toContain('SUBSTRAT_SERVICE_TOKEN: ${{ secrets.SUBSTRAT_SERVICE_TOKEN }}');
      // The deploy job now only fires on push — the same file also handles PRs.
      expect(yaml).toContain("if: github.event_name == 'push'");
    });

    it('generates PR-preview jobs that create on open/sync and reap on close', () => {
      const yaml = deployWorkflowYaml('main', 'hr-portal', 'https://console.example/api');
      // The PR trigger drives both the create and the cleanup jobs.
      expect(yaml).toContain('pull_request:');
      expect(yaml).toContain('types: [opened, synchronize, reopened, closed]');
      // Create/update on any non-close PR event; reap on close. Tag is the PR number, so
      // successive pushes rebind the same preview and closing reaps exactly it.
      expect(yaml).toContain(
        "if: github.event_name == 'pull_request' && github.event.action != 'closed'",
      );
      expect(yaml).toContain(
        "if: github.event_name == 'pull_request' && github.event.action == 'closed'",
      );
      expect(yaml).toContain(
        'preview create . --slug hr-portal --tag pr-${{ github.event.number }}',
      );
      expect(yaml).toContain(
        'preview delete --slug hr-portal --tag pr-${{ github.event.number }}',
      );
      // One run per PR at a time, and the create job can comment the URL back.
      expect(yaml).toContain('concurrency: substrat-preview-${{ github.event.number }}');
      expect(yaml).toContain('pull-requests: write');
    });

    it('surfaces missing App write-permissions as needsPermissions, before any write', async () => {
      // A pre-widening installation: the secrets API 403s/404s. No workflow commit happens.
      const denied = await setupRepoCi(cfgFor(fakeCiGithub({ keyStatus: 404 }).fetchImpl), '987', input);
      expect(denied).toEqual({ needsPermissions: true });
      const { writes, fetchImpl } = fakeCiGithub({ secretStatus: 403 });
      expect(await setupRepoCi(cfgFor(fetchImpl), '987', input)).toEqual({ needsPermissions: true });
      expect(writes.filter((w) => w.url.includes('/contents/'))).toHaveLength(0);
    });
  });
});
