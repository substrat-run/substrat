import { z } from 'zod';
import type { FetchLike } from '@substrat-run/kernel';
import { fromBase64, generateCertificate, thumbprintS256, toBase64Url } from './x509.js';

/**
 * The stored credential — one tenant's app registration, app-only, in its own Entra directory.
 *
 * What the tenant types: the directory and application ids, the addresses it allowed the app
 * to send as (scoped in Exchange with RBAC for Applications), the SharePoint site it granted,
 * and — only if it chose a client secret over our certificate — the secret.
 *
 * What the platform adds (`prepareMicrosoft365Candidate`): with no client secret, a keypair and
 * a self-signed certificate generated for THIS connection. The private key is sealed with the
 * rest of the secret and never leaves the platform; the tenant downloads the certificate.
 */
export const microsoft365Secret = z.object({
  tenantId: z.string().trim().min(1),
  clientId: z.string().trim().min(1),
  /** Comma- or whitespace-separated addresses. */
  senders: z.string().trim().min(1),
  siteUrl: z.string().trim().url(),
  clientSecret: z.string().optional(),
  privateKey: z.string().optional(),
  certificate: z.string().optional(),
  certificateNotAfter: z.string().optional(),
});
export type Microsoft365Secret = z.infer<typeof microsoft365Secret>;

/** The fields only the platform may write — never accepted from a caller's candidate. */
const GENERATED = ['privateKey', 'certificate', 'certificateNotAfter'] as const;

export const LOGIN_BASE = 'https://login.microsoftonline.com';
export const GRAPH_BASE = 'https://graph.microsoft.com';

export function sendersOf(secret: Pick<Microsoft365Secret, 'senders'>): string[] {
  return secret.senders
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export type AuthMethod = 'certificate' | 'client-secret';
export const authMethodOf = (s: Microsoft365Secret): AuthMethod =>
  s.clientSecret?.trim() ? 'client-secret' : 'certificate';

/**
 * Finish a candidate credential on the platform side, before it is probed and sealed.
 *
 * - A client secret: stored as given, and any generated key material dropped — with the
 *   connection's expiry cleared (`null`), since the certificate it described is gone.
 * - No client secret: the key is the platform's. A rotation that changes only the tenant's
 *   fields (a new sender, a corrected site) keeps the stored keypair, so the certificate the
 *   tenant already uploaded keeps working; a connection that has none, or whose certificate
 *   has lapsed, gets a new one.
 *
 * Key material in the candidate itself is always discarded: a caller cannot choose the key.
 */
export async function prepareMicrosoft365Candidate(
  candidate: Record<string, string>,
  previous: Record<string, string> | undefined,
  opts: { now: Date; commonName: string },
): Promise<{ secret: Record<string, string>; expiresAt: string | null }> {
  const secret = { ...candidate };
  for (const k of GENERATED) delete secret[k];
  // Entra does not report a client secret's end to an app-only caller, so there is none to set.
  if (secret.clientSecret?.trim()) return { secret, expiresAt: null };
  delete secret.clientSecret;

  const kept = previous?.privateKey && previous.certificate && previous.certificateNotAfter;
  if (kept && Date.parse(previous.certificateNotAfter!) > opts.now.getTime()) {
    return {
      secret: {
        ...secret,
        privateKey: previous.privateKey!,
        certificate: previous.certificate!,
        certificateNotAfter: previous.certificateNotAfter!,
      },
      expiresAt: previous.certificateNotAfter!,
    };
  }
  const minted = await generateCertificate({ commonName: opts.commonName, now: opts.now });
  return {
    secret: {
      ...secret,
      privateKey: minted.privateKey,
      certificate: minted.certificate,
      certificateNotAfter: minted.notAfter,
    },
    expiresAt: minted.notAfter,
  };
}

/** What a token request came back with. */
export type TokenOutcome =
  | { ok: true; accessToken: string }
  | {
      ok: false;
      /** Entra refused the credential for good (wrong ids, a bad secret) — not "try later". */
      refused: boolean;
      error: string;
    };

/**
 * An app-only Graph token for this credential (client credentials grant).
 *
 * With a certificate, the client assertion is a PS256 JWT naming the key by its `x5t#S256`
 * thumbprint, as Entra specifies for certificate credentials.
 */
export async function acquireToken(
  fetchImpl: FetchLike,
  secret: Microsoft365Secret,
  opts: { loginBase?: string; now: Date },
): Promise<TokenOutcome> {
  const loginBase = opts.loginBase ?? LOGIN_BASE;
  const endpoint = `${loginBase}/${encodeURIComponent(secret.tenantId)}/oauth2/v2.0/token`;
  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: secret.clientId,
    scope: `${GRAPH_BASE}/.default`,
  });
  if (authMethodOf(secret) === 'client-secret') {
    form.set('client_secret', secret.clientSecret!.trim());
  } else {
    if (!secret.privateKey || !secret.certificate) {
      return { ok: false, refused: true, error: 'no client secret and no certificate is stored for this connection' };
    }
    form.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    form.set('client_assertion', await clientAssertion(secret, endpoint, opts.now));
  }
  let res;
  try {
    res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
  } catch (e) {
    return { ok: false, refused: false, error: `Microsoft sign-in could not be reached: ${errorText(e)}` };
  }
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
    error_description?: string;
    error_codes?: number[];
  };
  if (res.ok && body.access_token) return { ok: true, accessToken: body.access_token };
  return classifyTokenError(res.status, body);
}

/**
 * Entra's refusals, sorted by what the person connecting can do about them.
 *
 * The one that matters most is the certificate not being on the app registration yet: the
 * connection is saved BEFORE the tenant can upload the certificate (they need it from us), so
 * that answer must read as "not yet", never as a refusal that blocks saving.
 */
export function classifyTokenError(
  status: number,
  body: { error?: string; error_description?: string; error_codes?: number[] },
): TokenOutcome & { ok: false } {
  const codes = new Set(body.error_codes ?? []);
  const said = firstLine(body.error_description) ?? body.error ?? `HTTP ${status}`;
  if (status >= 500) return { ok: false, refused: false, error: `Microsoft sign-in is unavailable (${said})` };
  // AADSTS700027: the assertion's key is not registered on the app (or not yet propagated).
  if (codes.has(700027)) {
    return {
      ok: false,
      refused: false,
      error:
        'the certificate is not on the app registration yet — download it here, upload it under ' +
        'Certificates & secrets, then test the connection again',
    };
  }
  // AADSTS700016: no such application in this directory. AADSTS90002 / 900023: no such directory.
  if (codes.has(700016)) return { ok: false, refused: true, error: `no application with this client id in the directory (${said})` };
  if (codes.has(90002) || codes.has(900023)) return { ok: false, refused: true, error: `no such directory (${said})` };
  // AADSTS7000215 / 7000222: the client secret is wrong / has expired.
  if (codes.has(7000215)) return { ok: false, refused: true, error: 'the client secret is not valid for this application' };
  if (codes.has(7000222)) return { ok: false, refused: true, error: 'the client secret has expired — create a new one' };
  return { ok: false, refused: status === 400 || status === 401, error: said };
}

async function clientAssertion(secret: Microsoft365Secret, audience: string, now: Date): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  const header = { alg: 'PS256', typ: 'JWT', 'x5t#S256': await thumbprintS256(secret.certificate!) };
  const claims = {
    aud: audience,
    iss: secret.clientId,
    sub: secret.clientId,
    jti: crypto.randomUUID(),
    nbf: iat,
    iat,
    exp: iat + 300,
  };
  const enc = (o: object) => toBase64Url(new TextEncoder().encode(JSON.stringify(o)));
  const signingInput = `${enc(header)}.${enc(claims)}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    fromBase64(secret.privateKey!),
    { name: 'RSA-PSS', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    { name: 'RSA-PSS', saltLength: 32 },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${toBase64Url(new Uint8Array(signature))}`;
}

const firstLine = (s: string | undefined) => s?.split(/\r?\n/)[0]?.trim() || undefined;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
