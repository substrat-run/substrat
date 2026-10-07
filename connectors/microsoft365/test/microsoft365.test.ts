import { URLSearchParams } from 'node:url';
import { X509Certificate, constants, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Connection } from '@substrat-run/contracts';
import type { FetchLike, ScopeHost } from '@substrat-run/kernel';
import {
  MAX_ATTACHMENT_BYTES,
  classifyTokenError,
  generateCertificate,
  microsoft365Certificate,
  microsoft365CredentialSummary,
  microsoft365MailSender,
  prepareMicrosoft365Candidate,
  probeMicrosoft365Secret,
  sitePath,
  thumbprintS256,
} from '../src/index.js';

/**
 * The Microsoft 365 connector against a stand-in for Entra's token endpoint and Graph.
 *
 * What a stand-in cannot prove is that Microsoft accepts these shapes — that waits for a real
 * tenant (the issue stays open for it). What it does prove: the certificate is a real X.509
 * certificate (Node's own parser reads and verifies it), the client assertion is signed by the
 * key the certificate carries and names it the way Entra specifies, and each answer Entra or
 * Graph can give lands on the right side of "refused" versus "not yet".
 */

const NOW = new Date('2026-10-07T12:00:00Z');
const base = {
  tenantId: '11111111-2222-3333-4444-555555555555',
  clientId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  senders: 'noreply@acme.example, office@acme.example',
  siteUrl: 'https://acme.sharepoint.com/sites/Team',
};

type Call = { url: string; method: string; headers: Record<string, string>; body: string };
type Routes = Record<string, { status: number; body: unknown }>;

/** A scripted Microsoft: the first route whose key the URL contains answers. */
function microsoft(routes: Routes) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ url: input, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: String(init?.body ?? '') });
    const key = Object.keys(routes).find((k) => input.includes(k));
    const r = key ? routes[key]! : { status: 404, body: { error: { code: 'itemNotFound', message: 'no route' } } };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
      arrayBuffer: async () => new ArrayBuffer(0),
    } as never;
  };
  return { calls, fetchImpl };
}

const tokenOk: Routes = { '/oauth2/v2.0/token': { status: 200, body: { access_token: 'TOKEN' } } };
const siteOk: Routes = {
  '/v1.0/sites/': { status: 200, body: { id: 'acme.sharepoint.com,1,2', displayName: 'Team', webUrl: base.siteUrl } },
};
const entraError = (codes: number[], status = 400): Routes => ({
  '/oauth2/v2.0/token': {
    status,
    body: { error: 'invalid_client', error_description: `AADSTS${codes[0]}: nope\nTrace ID: x`, error_codes: codes },
  },
});

const withCert = async () =>
  (await prepareMicrosoft365Candidate(base, undefined, { now: NOW, commonName: 'Substrat test' })).secret;

describe('the generated certificate', () => {
  it('is a real self-signed X.509 certificate for the stated year', async () => {
    const minted = await generateCertificate({ commonName: 'Substrat — acme', now: NOW });
    const cert = new X509Certificate(Buffer.from(minted.certificate, 'base64'));
    expect(cert.subject).toContain('CN=Substrat — acme');
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(new Date(cert.validTo).toISOString()).toBe(minted.notAfter);
    expect(Date.parse(minted.notAfter) - Date.parse(minted.notBefore)).toBe(365 * 86_400_000);
  });
});

describe('the client assertion', () => {
  it("is PS256, names the key by x5t#S256, and is signed by the certificate's key", async () => {
    const secret = await withCert();
    const ms = microsoft({ ...tokenOk, ...siteOk });
    const probe = await probeMicrosoft365Secret(secret, { fetch: ms.fetchImpl, now: () => NOW });
    expect(probe.ok).toBe(true);

    const form = new URLSearchParams(ms.calls[0]!.body);
    expect(ms.calls[0]!.url).toBe(`https://login.microsoftonline.com/${base.tenantId}/oauth2/v2.0/token`);
    expect(form.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    expect(form.get('scope')).toBe('https://graph.microsoft.com/.default');
    expect(form.get('client_secret')).toBeNull();

    const [h, c, sig] = form.get('client_assertion')!.split('.');
    const header = JSON.parse(Buffer.from(h!, 'base64url').toString());
    const claims = JSON.parse(Buffer.from(c!, 'base64url').toString());
    expect(header).toEqual({ alg: 'PS256', typ: 'JWT', 'x5t#S256': await thumbprintS256(secret.certificate!) });
    expect(claims).toMatchObject({
      aud: ms.calls[0]!.url,
      iss: base.clientId,
      sub: base.clientId,
      nbf: NOW.getTime() / 1000,
      exp: NOW.getTime() / 1000 + 300,
    });
    const publicKey = new X509Certificate(Buffer.from(secret.certificate!, 'base64')).publicKey;
    const signed = verify(
      'sha256',
      Buffer.from(`${h}.${c}`),
      { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
      Buffer.from(sig!, 'base64url'),
    );
    expect(signed).toBe(true);
  });

  it('with a client secret, sends the secret and no assertion', async () => {
    const ms = microsoft({ ...tokenOk, ...siteOk });
    await probeMicrosoft365Secret({ ...base, clientSecret: 'S3CRET-value' }, { fetch: ms.fetchImpl, now: () => NOW });
    const form = new URLSearchParams(ms.calls[0]!.body);
    expect(form.get('client_secret')).toBe('S3CRET-value');
    expect(form.get('client_assertion')).toBeNull();
  });
});

describe('preparing a candidate on the platform side', () => {
  it('generates a keypair when there is no client secret, and sets the expiry from it', async () => {
    const { secret, expiresAt } = await prepareMicrosoft365Candidate(base, undefined, { now: NOW, commonName: 'x' });
    expect(secret.privateKey).toBeTruthy();
    expect(secret.certificate).toBeTruthy();
    expect(expiresAt).toBe(secret.certificateNotAfter);
  });

  it('never takes key material from the caller', async () => {
    const { secret } = await prepareMicrosoft365Candidate(
      { ...base, privateKey: 'ATTACKER', certificate: 'ATTACKER', certificateNotAfter: '2099-01-01T00:00:00Z' },
      undefined,
      { now: NOW, commonName: 'x' },
    );
    expect(secret.privateKey).not.toBe('ATTACKER');
    expect(secret.certificate).not.toBe('ATTACKER');
  });

  it("keeps the stored keypair across an edit, so the tenant's uploaded certificate keeps working", async () => {
    const first = await withCert();
    const { secret } = await prepareMicrosoft365Candidate({ ...base, senders: 'new@acme.example' }, first, {
      now: NOW,
      commonName: 'x',
    });
    expect(secret.privateKey).toBe(first.privateKey);
    expect(secret.certificate).toBe(first.certificate);
    expect(secret.senders).toBe('new@acme.example');
  });

  it('mints a new one when the stored certificate has lapsed', async () => {
    const first = await withCert();
    const later = new Date(Date.parse(first.certificateNotAfter!) + 1000);
    const { secret } = await prepareMicrosoft365Candidate(base, first, { now: later, commonName: 'x' });
    expect(secret.certificate).not.toBe(first.certificate);
  });

  it('with a client secret, stores no key at all', async () => {
    const first = await withCert();
    const { secret, expiresAt } = await prepareMicrosoft365Candidate({ ...base, clientSecret: 'S' }, first, {
      now: NOW,
      commonName: 'x',
    });
    expect(secret.privateKey).toBeUndefined();
    expect(secret.certificate).toBeUndefined();
    // Cleared, not left: the expiry the connection held was the certificate's, and it is gone.
    expect(expiresAt).toBeNull();
  });
});

describe('what the probe says', () => {
  const probe = async (routes: Routes, secret?: Record<string, string>) =>
    probeMicrosoft365Secret(secret ?? (await withCert()), { fetch: microsoft(routes).fetchImpl, now: () => NOW });

  it('names the site when sign-in and site access both work', async () => {
    expect(await probe({ ...tokenOk, ...siteOk })).toMatchObject({
      ok: true,
      accountLabel: 'Team',
      accountRef: 'acme.sharepoint.com,1,2',
    });
  });

  it('a certificate not on the app registration yet is inconclusive, so the connection can be saved first', async () => {
    const p = await probe(entraError([700027], 401));
    expect(p).toMatchObject({ ok: false, refused: false });
    expect(p.error).toContain('not on the app registration yet');
  });

  it.each([
    [[700016], 'no application'],
    [[90002], 'no such directory'],
    [[7000215], 'client secret is not valid'],
    [[7000222], 'expired'],
  ])('Entra code %j is a refusal (%s)', async (codes, says) => {
    const p = await probe(entraError(codes));
    expect(p).toMatchObject({ ok: false, refused: true });
    expect(p.error).toContain(says);
  });

  it('signed in but the site not granted yet is inconclusive', async () => {
    const p = await probe({ ...tokenOk, '/v1.0/sites/': { status: 403, body: { error: { code: 'accessDenied', message: 'x' } } } });
    expect(p).toMatchObject({ ok: false, refused: false });
    expect(p.error).toContain('no access');
  });

  it('a site that does not exist is a refusal', async () => {
    const p = await probe({ ...tokenOk, '/v1.0/sites/': { status: 404, body: { error: { code: 'itemNotFound', message: 'x' } } } });
    expect(p).toMatchObject({ ok: false, refused: true });
  });

  it('Microsoft being down is inconclusive, never a refusal', () => {
    expect(classifyTokenError(503, {})).toMatchObject({ ok: false, refused: false });
  });

  it('an incomplete credential is refused before any request', async () => {
    const ms = microsoft({});
    const p = await probeMicrosoft365Secret({ tenantId: 'x' }, { fetch: ms.fetchImpl });
    expect(p.refused).toBe(true);
    expect(ms.calls).toHaveLength(0);
  });
});

describe('a connection: summary, certificate and mail', () => {
  const conn = {
    id: '01CONN',
    tenantId: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
    vertical: 'desk',
    provider: 'microsoft365',
  } as unknown as Connection;
  const hostWith = (secret: Record<string, string>) => {
    const uses: unknown[] = [];
    const host = {
      admin: {
        openConnection: async () => ({ ...conn, secret }),
        recordConnectionUse: async (_id: string, u: unknown) => void uses.push(u),
      },
    } as unknown as ScopeHost;
    return { host, uses };
  };
  const mail = (over: object = {}) => ({
    from: { email: 'office@acme.example', name: 'Acme' },
    to: [{ email: 'customer@example.com' }],
    subject: 'Your offer',
    html: '<p>Attached.</p>',
    text: 'Attached.',
    headers: { 'X-Ref': 'abc', 'List-Unsubscribe': '<mailto:x>' },
    attachments: [{ filename: 'offer.pdf', contentType: 'application/pdf', content: new Uint8Array([1, 2, 3]) }],
    ...over,
  });

  it('the summary never shows key material, and shows the thumbprint Entra shows', async () => {
    const secret = await withCert();
    const summary = await microsoft365CredentialSummary(hostWith(secret).host, conn);
    expect(JSON.stringify(summary)).not.toContain(secret.privateKey!);
    expect(summary.fields.find((f) => f.key === 'certificate')!.value).toMatch(/^[0-9A-F]{40}$/);
  });

  it('serves the public certificate as PEM, with the SHA-1 thumbprint — and nothing with a client secret', async () => {
    const cert = await microsoft365Certificate(hostWith(await withCert()).host, conn);
    expect(cert!.pem).toMatch(/^-----BEGIN CERTIFICATE-----\n/);
    expect(new X509Certificate(cert!.pem).fingerprint.replace(/:/g, '')).toBe(cert!.thumbprint);
    expect(await microsoft365Certificate(hostWith({ ...base, clientSecret: 'S' }).host, conn)).toBeNull();
  });

  it('sends with sendMail as the from address, inline attachments, X- headers only, health recorded', async () => {
    const ms = microsoft({ ...tokenOk, '/sendMail': { status: 202, body: {} } });
    const h = hostWith(await withCert());
    const sender = microsoft365MailSender({ fetch: ms.fetchImpl, now: () => NOW });

    expect(await sender.senders(h.host, conn)).toEqual(['noreply@acme.example', 'office@acme.example']);
    const result = await sender.send(h.host, conn, mail());

    expect(result).toEqual({ delivered: [], queued: ['customer@example.com'], bounced: [] });
    const send = ms.calls.find((c) => c.url.endsWith('/sendMail'))!;
    expect(send.url).toBe('https://graph.microsoft.com/v1.0/users/office%40acme.example/sendMail');
    expect(send.headers.authorization).toBe('Bearer TOKEN');
    const body = JSON.parse(send.body);
    expect(body.saveToSentItems).toBe(true);
    expect(body.message).toMatchObject({
      subject: 'Your offer',
      body: { contentType: 'HTML', content: '<p>Attached.</p>' },
      toRecipients: [{ emailAddress: { address: 'customer@example.com' } }],
      internetMessageHeaders: [{ name: 'X-Ref', value: 'abc' }],
      attachments: [
        { '@odata.type': '#microsoft.graph.fileAttachment', name: 'offer.pdf', contentType: 'application/pdf', contentBytes: 'AQID' },
      ],
    });
    expect(h.uses).toHaveLength(2); // token + sendMail, each settled against the connection
  });

  it('refuses attachments over the inline limit before calling Graph, saying why', async () => {
    const ms = microsoft({ ...tokenOk, '/sendMail': { status: 202, body: {} } });
    const big = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
    await expect(
      microsoft365MailSender({ fetch: ms.fetchImpl, now: () => NOW }).send(
        hostWith(await withCert()).host,
        conn,
        mail({ attachments: [{ filename: 'big.bin', contentType: 'application/octet-stream', content: big }] }),
      ),
    ).rejects.toThrow(/Mail\.ReadWrite/);
    expect(ms.calls.some((c) => c.url.endsWith('/sendMail'))).toBe(false);
  });

  it('an Exchange refusal reads as outside the scope the tenant granted', async () => {
    const ms = microsoft({
      ...tokenOk,
      '/sendMail': { status: 403, body: { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } } },
    });
    await expect(
      microsoft365MailSender({ fetch: ms.fetchImpl, now: () => NOW }).send(hostWith(await withCert()).host, conn, mail()),
    ).rejects.toThrow(/outside the scope the tenant granted/);
  });

  it('refuses a connection row that is not the live one', async () => {
    const other = { ...conn, id: '01OTHER' } as Connection;
    await expect(
      microsoft365MailSender({ fetch: microsoft({}).fetchImpl }).senders(hostWith(await withCert()).host, other),
    ).rejects.toThrow(/not the live/);
  });
});

describe('sitePath', () => {
  it("maps a site URL onto Graph's host-and-path address", () => {
    expect(sitePath('https://acme.sharepoint.com/sites/Team/')).toBe('sites/acme.sharepoint.com:/sites/Team');
    expect(sitePath('https://acme.sharepoint.com')).toBe('sites/acme.sharepoint.com');
  });
});
