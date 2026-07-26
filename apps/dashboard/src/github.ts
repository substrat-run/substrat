/**
 * GitHub App boundary — the only file that talks to api.github.com.
 *
 * This is host code (a connector-shaped adapter for the outside world, never module
 * code): it holds the App's private key, mints short-lived tokens, and lists repos.
 * The per-tenant connection stores only the `installationId` (which repos the tenant
 * granted us) — never a long-lived token. An installation access token is minted on
 * demand from the App JWT and expires in an hour, so nothing durable is a bearer
 * secret. The App private key is platform infrastructure (a worker secret), not
 * per-tenant.
 *
 * Flow: App JWT (RS256, signed with the private key) → installation access token
 * (`POST /app/installations/:id/access_tokens`) → repo list (`GET
 * /installation/repositories`). See docs/design/connections.md §3.5.1.
 */

const API = 'https://api.github.com';
const UA = 'substrat-dashboard';

/** What the worker needs to act as the App. All come from secrets (see Env). */
export interface GithubConfig {
  appId: string;
  /** The App's public slug — builds the install URL `github.com/apps/<slug>/installations/new`. */
  appSlug: string;
  /** RSA private key PEM, RS256 — PKCS#8 or PKCS#1 (the format GitHub's key download uses). A worker secret. */
  privateKeyPem: string;
  /**
   * The HTTP client, injected (never the global). Same seam as authority.ts: this is
   * host/edge code, so it carries `fetch` as a dependency rather than reaching for the
   * ambient one — which is also what keeps boundary-lint's R3 honest.
   */
  fetchImpl: typeof globalThis.fetch;
}

/** Read the GitHub App config from the environment, or `null` if it isn't configured. */
export function githubConfig(
  env: { GITHUB_APP_ID?: string; GITHUB_APP_SLUG?: string; GITHUB_APP_PRIVATE_KEY?: string },
  fetchImpl: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): GithubConfig | null {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_SLUG || !env.GITHUB_APP_PRIVATE_KEY) return null;
  return { appId: env.GITHUB_APP_ID, appSlug: env.GITHUB_APP_SLUG, privateKeyPem: env.GITHUB_APP_PRIVATE_KEY, fetchImpl };
}

/** The URL a tenant admin is sent to, to install the App and pick repos. `state` is our signed token. */
export function installUrl(cfg: GithubConfig, state: string): string {
  return `https://github.com/apps/${encodeURIComponent(cfg.appSlug)}/installations/new?state=${encodeURIComponent(state)}`;
}

const b64url = (bytes: ArrayBuffer | Uint8Array): string => {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/**
 * Wrap a PKCS#1 `RSAPrivateKey` DER in a PKCS#8 `PrivateKeyInfo` (rsaEncryption).
 * GitHub's App key download is PKCS#1 (`BEGIN RSA PRIVATE KEY`), which Web Crypto's
 * `importKey('pkcs8', …)` rejects with `DataError` — so the raw downloaded PEM pasted
 * into the secret would break every GitHub call. Wrapping is a fixed DER prefix.
 */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const derLen = (n: number): number[] => (n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff]);
  const version = [0x02, 0x01, 0x00];
  // AlgorithmIdentifier { OID 1.2.840.113549.1.1.1 (rsaEncryption), NULL }
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octetHeader = [0x04, ...derLen(pkcs1.length)];
  const bodyLen = version.length + algorithm.length + octetHeader.length + pkcs1.length;
  return Uint8Array.from([0x30, ...derLen(bodyLen), ...version, ...algorithm, ...octetHeader, ...pkcs1]);
}

/** Import an RSA private key PEM (PKCS#8, or PKCS#1 as GitHub downloads it) as an RS256 signing key. */
async function importKey(pem: string): Promise<CryptoKey> {
  // PKCS#1 is detectable from the marker; check before the markers are stripped.
  const isPkcs1 = /BEGIN\s+RSA\s+PRIVATE\s+KEY/.test(pem);
  const der = pem
    // Single-line secrets often carry literal "\n"/"\r" escape sequences rather than
    // real newlines; drop them BEFORE stripping whitespace so no stray char survives
    // into the base64 (a leftover backslash would make atob throw "invalid base64").
    .replace(/\\[rn]/g, '')
    .replace(/-----[^-]+-----/g, '') // BEGIN/END markers
    .replace(/\s+/g, '');
  const bytes = Uint8Array.from(atob(der), (ch) => ch.charCodeAt(0));
  const pkcs8 = isPkcs1 ? pkcs1ToPkcs8(bytes) : bytes;
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

/** A GitHub App JWT — proves we are the App. Short-lived (10 min max, per GitHub). */
async function appJwt(cfg: GithubConfig): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  // `iat` back-dated 60s for clock drift; `exp` well inside GitHub's 10-min ceiling.
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: cfg.appId })));
  const signingInput = `${header}.${payload}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await importKey(cfg.privateKeyPem), new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(sig)}`;
}

async function gh(cfg: GithubConfig, url: string, auth: string, init?: RequestInit): Promise<Response> {
  return cfg.fetchImpl(`${API}${url}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: auth,
      'user-agent': UA,
      'x-github-api-version': '2022-11-28',
      ...(init?.headers as Record<string, string>),
    },
  });
}

/** Mint a short-lived installation access token (acts on the repos the tenant granted). */
async function installationToken(cfg: GithubConfig, installationId: string): Promise<string> {
  const res = await gh(cfg, `/app/installations/${encodeURIComponent(installationId)}/access_tokens`, `Bearer ${await appJwt(cfg)}`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`github: installation token failed (${res.status})`);
  return ((await res.json()) as { token: string }).token;
}

/** The GitHub account (org/user login) an installation belongs to — our `externalAccountRef`. */
export async function installationAccount(cfg: GithubConfig, installationId: string): Promise<string | null> {
  const res = await gh(cfg, `/app/installations/${encodeURIComponent(installationId)}`, `Bearer ${await appJwt(cfg)}`);
  if (!res.ok) return null;
  const body = (await res.json()) as { account?: { login?: string } | null };
  return body.account?.login ?? null;
}

/** One repository, trimmed to what the import UI needs. */
export interface GithubRepo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  updatedAt: string;
}

/** One branch of a repo, as the import UI's branch picker needs it. */
export interface GithubBranch {
  name: string;
}

/** List a repo's branches with the installation's token (paginates to a sane cap). */
export async function listRepoBranches(
  cfg: GithubConfig,
  installationId: string,
  repoFullName: string,
): Promise<GithubBranch[]> {
  const token = await installationToken(cfg, installationId);
  const repo = encodeRepo(repoFullName);
  const branches: GithubBranch[] = [];
  for (let page = 1; page <= 5; page++) {
    const res = await gh(cfg, `/repos/${repo}/branches?per_page=100&page=${page}`, `token ${token}`);
    if (!res.ok) throw new Error(`github: list branches failed (${res.status})`);
    const body = (await res.json()) as Array<{ name: string }>;
    for (const b of body) branches.push({ name: b.name });
    if (body.length < 100) break;
  }
  return branches;
}

/** `owner/name` → path segments, each encoded (a repo name can't contain `/` beyond the one). */
const encodeRepo = (fullName: string): string =>
  fullName.split('/').map(encodeURIComponent).join('/');

export interface SetupRepoCiInput {
  repoFullName: string;
  branch: string;
  /** e.g. `.github/workflows/substrat-deploy.yml` */
  workflowPath: string;
  workflowContent: string;
  /** e.g. `SUBSTRAT_SERVICE_TOKEN` */
  secretName: string;
  secretValue: string;
  /** Seals `secretValue` to the repo's Actions public key (github-seal.ts, injected for testability). */
  seal: (message: string, recipientPublicKeyB64: string) => string;
}

/**
 * One-click CI setup on a customer repo: write the push credential as an Actions
 * secret, then commit the deploy workflow to the chosen branch. Both writes need the
 * App's WIDENED permissions (contents: write, workflows, secrets) — a 403/404 from
 * GitHub on an app installed before the widening surfaces as `needsPermissions`, so
 * the UI can say "re-approve the App" instead of failing opaquely. Secret BEFORE
 * workflow: committing the workflow triggers a CI run immediately, and that first run
 * must already find its credential.
 */
export async function setupRepoCi(
  cfg: GithubConfig,
  installationId: string,
  input: SetupRepoCiInput,
): Promise<{ workflowUpdated: boolean } | { needsPermissions: true }> {
  const token = await installationToken(cfg, installationId);
  const repo = encodeRepo(input.repoFullName);

  // The repo's Actions public key — GitHub only accepts secrets sealed to it.
  const keyRes = await gh(cfg, `/repos/${repo}/actions/secrets/public-key`, `token ${token}`);
  if (keyRes.status === 403 || keyRes.status === 404) return { needsPermissions: true };
  if (!keyRes.ok) throw new Error(`github: actions public key failed (${keyRes.status})`);
  const { key, key_id } = (await keyRes.json()) as { key: string; key_id: string };

  const secretRes = await gh(
    cfg,
    `/repos/${repo}/actions/secrets/${encodeURIComponent(input.secretName)}`,
    `token ${token}`,
    {
      method: 'PUT',
      body: JSON.stringify({ encrypted_value: input.seal(input.secretValue, key), key_id }),
      headers: { 'content-type': 'application/json' },
    },
  );
  if (secretRes.status === 403) return { needsPermissions: true };
  if (!secretRes.ok) throw new Error(`github: set actions secret failed (${secretRes.status})`);

  // Create-or-update the workflow file: the contents API needs the existing blob's
  // sha to update, and 404s when the file is new — both are fine.
  const path = input.workflowPath.split('/').map(encodeURIComponent).join('/');
  const existing = await gh(
    cfg,
    `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(input.branch)}`,
    `token ${token}`,
  );
  const sha = existing.ok ? ((await existing.json()) as { sha?: string }).sha : undefined;

  const bytes = new TextEncoder().encode(input.workflowContent);
  const put = await gh(cfg, `/repos/${repo}/contents/${path}`, `token ${token}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: sha ? 'Update Substrat deploy workflow' : 'Add Substrat deploy workflow',
      content: btoa(String.fromCharCode(...bytes)),
      branch: input.branch,
      ...(sha ? { sha } : {}),
    }),
    headers: { 'content-type': 'application/json' },
  });
  // Committing under .github/workflows without the `workflows` permission is a 403
  // (and on some paths a 404) — the re-approve case again, not a hard error.
  if (put.status === 403 || put.status === 404) return { needsPermissions: true };
  if (!put.ok) throw new Error(`github: commit workflow failed (${put.status})`);
  return { workflowUpdated: Boolean(sha) };
}

/**
 * The workflow one-click setup commits — kept host-side (never the SPA) and shared
 * with the manual copy-paste path (`GET /api/github/workflow-preview`), so the
 * committed file and the manual instructions can never drift from what the platform
 * expects. The install step is load-bearing: `substrat push` runs the repo's own
 * build (wrangler custom build), which needs the repo's devDependencies on disk —
 * the lockfile picks the package manager, via corepack for pnpm/yarn.
 */
export function deployWorkflowYaml(branch: string, slug: string, cpUrl: string): string {
  return `name: Deploy to Substrat
on:
  push:
    branches: [${branch}]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          # 22+: corepack resolves the latest pnpm for lockfile-only repos, and pnpm 11
          # needs Node >= 22.13 (node:sqlite).
          node-version: 22
      - name: Install dependencies
        env:
          COREPACK_ENABLE_DOWNLOAD_PROMPT: '0'
        run: |
          if [ -f pnpm-lock.yaml ]; then corepack enable && pnpm install --frozen-lockfile
          elif [ -f yarn.lock ]; then corepack enable && yarn install --frozen-lockfile
          elif [ -f package-lock.json ]; then npm ci
          else npm install
          fi
      - run: npx @substrat-run/cli push . --slug ${slug} --version 0.1.\${{ github.run_number }}
        env:
          SUBSTRAT_SERVICE_TOKEN: \${{ secrets.SUBSTRAT_SERVICE_TOKEN }}
          SUBSTRAT_CP_URL: ${cpUrl}
`;
}

/** List the repos the tenant granted this installation (paginates to a sane cap). */
export async function listInstallationRepos(cfg: GithubConfig, installationId: string): Promise<GithubRepo[]> {
  const token = await installationToken(cfg, installationId);
  const repos: GithubRepo[] = [];
  for (let page = 1; page <= 5; page++) {
    const res = await gh(cfg, `/installation/repositories?per_page=100&page=${page}`, `token ${token}`);
    if (!res.ok) throw new Error(`github: list repositories failed (${res.status})`);
    const body = (await res.json()) as {
      repositories: Array<{ full_name: string; default_branch: string; private: boolean; updated_at: string }>;
    };
    for (const r of body.repositories) {
      repos.push({ fullName: r.full_name, defaultBranch: r.default_branch, private: r.private, updatedAt: r.updated_at });
    }
    if (body.repositories.length < 100) break;
  }
  return repos;
}
