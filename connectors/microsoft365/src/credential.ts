import { z } from 'zod';
import { deriveExpiryWarning } from '@substrat-run/contracts';
import type { FetchLike } from '@substrat-run/kernel';
import { certificateMatchesKey, fromBase64, generateCertificate, thumbprintS256, toBase64Url } from './x509.js';

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
 *
 * While a certificate is being rotated, a second keypair — the `next*` fields — sits beside the
 * current one until the tenant has uploaded it (see `prepareMicrosoft365Candidate`).
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
  nextPrivateKey: z.string().optional(),
  nextCertificate: z.string().optional(),
  nextCertificateNotAfter: z.string().optional(),
});
export type Microsoft365Secret = z.infer<typeof microsoft365Secret>;

/** The fields only the platform may write — never accepted from a caller's candidate. */
const GENERATED = [
  'privateKey',
  'certificate',
  'certificateNotAfter',
  'nextPrivateKey',
  'nextCertificate',
  'nextCertificateNotAfter',
] as const;

/**
 * The candidate field that asks for a new certificate now, ahead of the window. `'yes'` asks;
 * anything else, or absence, does not. It is an instruction, never stored.
 */
export const ROTATE_FIELD = 'rotateCertificate';

/** How long before the current certificate's end a save mints its successor. */
export const ROTATION_WINDOW_DAYS = 30;

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
 *   tenant already uploaded keeps working; a connection that has none, whose certificate
 *   has lapsed, or whose certificate is malformed or not its key's, gets a new one.
 *
 * Key material in the candidate itself is always discarded: a caller cannot choose the key.
 *
 * **Rotation** puts a second keypair beside the first, so mail never stops while the tenant
 * swaps certificates:
 *
 * - A save within {@link ROTATION_WINDOW_DAYS} days of the current certificate's end, or one that
 *   asks for it ({@link ROTATE_FIELD}), mints the successor beside it. The current one keeps
 *   signing, and the connection's expiry stays the current one's: that is the deadline.
 * - A later save signs in with the successor (`signIn`). If Entra accepts it, the tenant has
 *   uploaded it: it becomes the current certificate and the old key is dropped. If Entra does not
 *   accept it, or cannot be asked, both stay as they are. The successor's failure never touches
 *   the current one.
 * - Once the current certificate has lapsed, the successor is all that is left and takes its
 *   place.
 * - A successor already pending is kept, not re-minted, even when rotation is asked for again:
 *   the tenant may have downloaded it already.
 */
export async function prepareMicrosoft365Candidate(
  candidate: Record<string, string>,
  previous: Record<string, string> | undefined,
  opts: {
    now: Date;
    commonName: string;
    /** Signs in with a credential. Without it, a pending successor is kept but never promoted on a save. */
    signIn?: (secret: Microsoft365Secret) => Promise<TokenOutcome>;
  },
): Promise<{ secret: Record<string, string>; expiresAt: string | null }> {
  const secret = { ...candidate };
  const rotate = secret[ROTATE_FIELD] === 'yes';
  delete secret[ROTATE_FIELD];
  for (const k of GENERATED) delete secret[k];
  // Entra does not report a client secret's end to an app-only caller, so there is none to set.
  if (secret.clientSecret?.trim()) return { secret, expiresAt: null };
  delete secret.clientSecret;

  let [current, next] = await Promise.all([
    storedKeypair(previous, 'current', opts.now),
    storedKeypair(previous, 'next', opts.now),
  ]);
  if (!current && next) {
    current = next;
    next = undefined;
  } else if (current && next && opts.signIn) {
    // An incomplete candidate cannot sign in; the probe after this refuses it, so promotion just waits.
    const asNext = microsoft365Secret.safeParse({ ...secret, ...slot(next, 'current') });
    const outcome = asNext.success ? await opts.signIn(asNext.data).catch(() => undefined) : undefined;
    if (outcome?.ok) {
      current = next;
      next = undefined;
    }
  }
  if (!current) {
    current = await mint(opts);
  } else if (!next && (rotate || rotationDue(current.notAfter, opts.now))) {
    next = await mint(opts);
  }
  return {
    secret: { ...secret, ...slot(current, 'current'), ...(next ? slot(next, 'next') : {}) },
    expiresAt: current.notAfter,
  };
}

/** Is the certificate ending at `notAfter` within the rotation window at `now`? Inclusive. */
const rotationDue = (notAfter: string, now: Date): boolean =>
  deriveExpiryWarning(notAfter, now, ROTATION_WINDOW_DAYS) !== null;

interface Keypair {
  privateKey: string;
  certificate: string;
  notAfter: string;
}

const FIELDS = {
  current: { privateKey: 'privateKey', certificate: 'certificate', notAfter: 'certificateNotAfter' },
  next: { privateKey: 'nextPrivateKey', certificate: 'nextCertificate', notAfter: 'nextCertificateNotAfter' },
} as const;

/**
 * A stored keypair, kept only while it is unexpired AND its certificate reads as the certificate of
 * its key; one that does not (#2189: a non-minimal serial) is treated as absent, so the connection
 * heals on its next save.
 */
async function storedKeypair(
  stored: Record<string, string> | undefined,
  which: keyof typeof FIELDS,
  now: Date,
): Promise<Keypair | undefined> {
  const f = FIELDS[which];
  const privateKey = stored?.[f.privateKey];
  const certificate = stored?.[f.certificate];
  const notAfter = stored?.[f.notAfter];
  if (!privateKey || !certificate || !notAfter) return undefined;
  if (!(Date.parse(notAfter) > now.getTime())) return undefined;
  if (!(await certificateMatchesKey(certificate, privateKey))) return undefined;
  return { privateKey, certificate, notAfter };
}

function slot(k: Keypair, which: keyof typeof FIELDS): Record<string, string> {
  const f = FIELDS[which];
  return { [f.privateKey]: k.privateKey, [f.certificate]: k.certificate, [f.notAfter]: k.notAfter };
}

async function mint(opts: { now: Date; commonName: string }): Promise<Keypair> {
  const minted = await generateCertificate({ commonName: opts.commonName, now: opts.now });
  return { privateKey: minted.privateKey, certificate: minted.certificate, notAfter: minted.notAfter };
}

/**
 * The credential signing with the successor only — what checks whether the tenant uploaded it.
 * `undefined` when no rotation is under way, or the credential signs in with a client secret.
 */
export function withNextOnly(secret: Microsoft365Secret): Microsoft365Secret | undefined {
  const { nextPrivateKey, nextCertificate, nextCertificateNotAfter, ...rest } = secret;
  if (authMethodOf(secret) !== 'certificate' || !nextPrivateKey || !nextCertificate || !nextCertificateNotAfter) {
    return undefined;
  }
  return {
    ...rest,
    ...slot({ privateKey: nextPrivateKey, certificate: nextCertificate, notAfter: nextCertificateNotAfter }, 'current'),
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
      /** Entra says the assertion's key is not on the app registration (AADSTS700027). */
      notRegistered?: true;
    };

/**
 * An app-only Graph token for this credential (client credentials grant).
 *
 * With a certificate, the client assertion is a PS256 JWT naming the key by its `x5t#S256`
 * thumbprint, as Entra specifies for certificate credentials.
 *
 * During a rotation the current certificate signs. The successor signs only when the current one
 * has lapsed, or when Entra says the current one is not on the app registration (the tenant
 * removed it after uploading the successor). If the successor is refused too, the answer is the
 * current certificate's, so a successor not uploaded yet never changes what a send reports.
 */
export async function acquireToken(
  fetchImpl: FetchLike,
  secret: Microsoft365Secret,
  opts: { loginBase?: string; now: Date },
): Promise<TokenOutcome> {
  const next = withNextOnly(secret);
  if (!next) return requestToken(fetchImpl, secret, opts);
  const lapsed = secret.certificateNotAfter !== undefined && !(Date.parse(secret.certificateNotAfter) > opts.now.getTime());
  if (lapsed) return requestToken(fetchImpl, next, opts);
  const first = await requestToken(fetchImpl, secret, opts);
  if (first.ok || !first.notRegistered) return first;
  const second = await requestToken(fetchImpl, next, opts);
  return second.ok ? second : first;
}

async function requestToken(
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

/** AADSTS700027: the assertion's key is not registered on the app (or not yet propagated). */
const KEY_NOT_REGISTERED = 700027;

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
  if (codes.has(KEY_NOT_REGISTERED)) {
    return {
      ok: false,
      refused: false,
      notRegistered: true,
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
