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
