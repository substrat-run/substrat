import { URLSearchParams } from 'node:url';
import { X509Certificate, constants, createPrivateKey, createPublicKey, createSign, createVerify, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { connectionCertificate, type Connection } from '@substrat-run/contracts';
import type { FetchLike, ScopeHost } from '@substrat-run/kernel';
import {
  MAX_ATTACHMENT_BYTES,
  classifyTokenError,
  generateCertificate,
  microsoft365Certificate,
  microsoft365CredentialSummary,
  microsoft365MailSender,
  prepareMicrosoft365,
  prepareMicrosoft365Candidate,
  probeMicrosoft365Connection,
  probeMicrosoft365Secret,
  sitePath,
  thumbprintS256,
  type Microsoft365Secret,
} from '../src/index.js';
import { acquireToken } from '../src/credential.js';
import { certificateMatchesKey, integer } from '../src/x509.js';

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

const conn = {
  id: '01CONN',
  tenantId: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
  vertical: 'desk',
  provider: 'microsoft365',
} as unknown as Connection;
/** A host whose live connection holds `secret`, recording each use the connector settles. */
const hostWith = (secret: Record<string, string>) => {
  const uses: { ok: boolean }[] = [];
  const host = {
    admin: {
      openConnection: async () => ({ ...conn, secret }),
      recordConnectionUse: async (_id: string, u: { ok: boolean }) => void uses.push(u),
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

describe('the generated certificate', () => {
  it('is a real self-signed X.509 certificate for the stated year', async () => {
    const minted = await generateCertificate({ commonName: 'Substrat — acme', now: NOW });
    const cert = new X509Certificate(Buffer.from(minted.certificate, 'base64'));
    expect(cert.subject).toContain('CN=Substrat — acme');
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(new Date(cert.validTo).toISOString()).toBe(minted.notAfter);
    expect(Date.parse(minted.notAfter) - Date.parse(minted.notBefore)).toBe(365 * 86_400_000);
  });

  // #2189: the serial was masked positive but not made shortest-form, so a leading 0x00 followed by a
  // byte under 0x80 (one draw in 256) was a non-minimal DER INTEGER that OpenSSL — and Node — refuse.
  // The draw is fixed here so the case is not left to chance; every row is parsed by Node's own parser.
  const withSerialPrefix = (...prefix: number[]) => (bytes: Uint8Array) => {
    bytes.fill(0x5a);
    bytes.set(prefix);
    return bytes;
  };
  it.each([
    ['00 7f', [0x00, 0x7f]],
    ['00 01', [0x00, 0x01]],
    ['00 00 00', [0x00, 0x00, 0x00]],
    ['80 ff (high bit set)', [0x80, 0xff]],
    ['ff ff', [0xff, 0xff]],
  ])('parses with a serial that begins %s', async (_label, prefix) => {
    const minted = await generateCertificate({
      commonName: 'x',
      now: NOW,
      random: withSerialPrefix(...prefix!),
    });
    const cert = new X509Certificate(Buffer.from(minted.certificate, 'base64'));
    expect(cert.verify(cert.publicKey)).toBe(true);
    // Positive and 16 octets with no redundant zero: the first byte is never 0x00.
    expect(cert.serialNumber).toMatch(/^[1-7][0-9A-F]{31}$/);
  });

  it('a serial that already begins with a clean positive byte is kept as drawn', async () => {
    const minted = await generateCertificate({ commonName: 'x', now: NOW, random: withSerialPrefix(0x41, 0x01) });
    const cert = new X509Certificate(Buffer.from(minted.certificate, 'base64'));
    expect(cert.serialNumber.startsWith('4101')).toBe(true);
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

describe('integer()', () => {
  const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
  it.each([
    ['00', [0x00], '020100'],
    ['7f', [0x7f], '02017f'],
    ['80 gets the pad', [0x80], '02020080'],
    ['ff gets the pad', [0xff], '020200ff'],
    ['redundant zeros are dropped', [0x00, 0x00, 0x7f], '02017f'],
    ['one zero stays before a high bit', [0x00, 0x80], '02020080'],
    ['zeros then a high bit keep one pad', [0x00, 0x00, 0xff, 0x01], '020300ff01'],
    ['all zeros is a single zero', [0x00, 0x00, 0x00], '020100'],
    ['255/256 boundary', [0x01, 0x00], '02020100'],
  ])('%s', (_l, bytes, der) => {
    expect(hex(integer(new Uint8Array(bytes)))).toBe(der);
  });
});

describe('a stored certificate is judged before it is kept (#2189)', () => {
  /** A valid certificate re-signed with a serial beginning 00 7f: what the old encoder could draw. */
  async function malformed() {
    const good = await generateCertificate({ commonName: 'x', now: NOW });
    const der = Buffer.from(good.certificate, 'base64');
    const at = der.indexOf(Buffer.from('a003020102', 'hex')) + 5; // the serial's tag
    expect(der[at]).toBe(0x02);
    expect(der[at + 1]).toBe(16);
    der[at + 2] = 0x00;
    der[at + 3] = 0x7f;
    // der: 30 82 LL LL (certificate) | 30 82 TT TT (tbs, length at offset 6) | … | signature (last 256).
    expect(der.subarray(4, 6).toString('hex')).toBe('3082');
    const tbs = der.subarray(4, 8 + der.readUInt16BE(6));
    const key = createPrivateKey({ key: Buffer.from(good.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
    createSign('sha256').update(tbs).sign(key).copy(der, der.length - 256);
    // The fixture must be sound in every way but the serial, or it would fail the signature check
    // and never reach the serial one: assert it verifies.
    const signed = createVerify('sha256').update(tbs).verify(createPublicKey(key), der.subarray(der.length - 256));
    expect(signed).toBe(true);
    return { ...good, certificate: der.toString('base64') };
  }
  const stored = (m: { privateKey: string; certificate: string; notAfter: string }) => ({
    privateKey: m.privateKey,
    certificate: m.certificate,
    certificateNotAfter: m.notAfter,
  });

  it('the fixture really is unreadable to Node, and is judged malformed', async () => {
    const bad = await malformed();
    expect(() => new X509Certificate(Buffer.from(bad.certificate, 'base64'))).toThrow();
    expect(await certificateMatchesKey(bad.certificate, bad.privateKey)).toBe(false);
  });

  it('a malformed unexpired certificate is re-minted on the next prepare', async () => {
    const bad = await malformed();
    const { secret, expiresAt } = await prepareMicrosoft365Candidate(base, stored(bad), { now: NOW, commonName: 'x' });
    expect(secret.certificate).not.toBe(bad.certificate);
    expect(secret.privateKey).not.toBe(bad.privateKey);
    expect(() => new X509Certificate(Buffer.from(secret.certificate!, 'base64'))).not.toThrow();
    expect(expiresAt).toBe(secret.certificateNotAfter);
  });

  it('a certificate whose signature does not verify is re-minted', async () => {
    const good = await generateCertificate({ commonName: 'x', now: NOW });
    const der = Buffer.from(good.certificate, 'base64');
    der[der.length - 1]! ^= 0x01;
    const bad = { ...good, certificate: der.toString('base64') };
    expect(await certificateMatchesKey(bad.certificate, bad.privateKey)).toBe(false);
    const { secret } = await prepareMicrosoft365Candidate(base, stored(bad), { now: NOW, commonName: 'x' });
    expect(secret.certificate).not.toBe(bad.certificate);
  });

  it.each([
    ['an outer signatureAlgorithm that is', 'outer'],
    ['a TBS signature algorithm that is', 'inner'],
  ])('a certificate with %s not sha256WithRSAEncryption is re-minted', async (_l, which) => {
    const good = await generateCertificate({ commonName: 'x', now: NOW });
    const der = Buffer.from(good.certificate, 'base64');
    // sha256WithRSAEncryption …01 0b → sha384WithRSAEncryption …01 0c; the first hit is the TBS's, the last the outer's.
    const needle = Buffer.from('2a864886f70d01010b', 'hex');
    const at = which === 'inner' ? der.indexOf(needle) : der.lastIndexOf(needle);
    der[at + needle.length - 1] = 0x0c;
    if (which === 'inner') {
      // Re-sign, so the signature is sound and only the algorithm check can refuse it.
      const key = createPrivateKey({ key: Buffer.from(good.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
      createSign('sha256').update(der.subarray(4, 8 + der.readUInt16BE(6))).sign(key).copy(der, der.length - 256);
    }
    const bad = { ...good, certificate: der.toString('base64') };
    expect(await certificateMatchesKey(bad.certificate, bad.privateKey)).toBe(false);
    const { secret } = await prepareMicrosoft365Candidate(base, stored(bad), { now: NOW, commonName: 'x' });
    expect(secret.certificate).not.toBe(bad.certificate);
  });

  it('a valid unexpired certificate is kept, not re-minted', async () => {
    const good = await generateCertificate({ commonName: 'x', now: NOW });
    expect(await certificateMatchesKey(good.certificate, good.privateKey)).toBe(true);
    const { secret } = await prepareMicrosoft365Candidate(base, stored(good), { now: NOW, commonName: 'x' });
    expect(secret.certificate).toBe(good.certificate);
    expect(secret.privateKey).toBe(good.privateKey);
  });

  it('a certificate that is not the stored key\'s is re-minted', async () => {
    const a = await generateCertificate({ commonName: 'x', now: NOW });
    const b = await generateCertificate({ commonName: 'x', now: NOW });
    expect(await certificateMatchesKey(a.certificate, b.privateKey)).toBe(false);
    const { secret } = await prepareMicrosoft365Candidate(base, stored({ ...a, privateKey: b.privateKey }), {
      now: NOW,
      commonName: 'x',
    });
    expect(secret.certificate).not.toBe(a.certificate);
  });

  it('refuses a random() that does not return the 16 bytes', async () => {
    await expect(generateCertificate({ commonName: 'x', now: NOW, random: () => new Uint8Array(8) })).rejects.toThrow(
      /16 serial bytes/,
    );
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

/**
 * Rotation: a successor keypair beside the current one, so mail never stops while the tenant swaps
 * certificates. The scripted Entra here decides by the assertion's `x5t#S256`, so "the tenant has
 * uploaded this certificate" is a set of thumbprints the test controls.
 */
describe('rotating the certificate before it lapses', () => {
  const prepare = (
    candidate: Record<string, string>,
    previous: Record<string, string> | undefined,
    now: Date,
    signIn?: Parameters<typeof prepareMicrosoft365Candidate>[2]['signIn'],
  ) => prepareMicrosoft365Candidate(candidate, previous, { now, commonName: 'x', ...(signIn ? { signIn } : {}) });
  // 30 days written out, not ROTATION_WINDOW_DAYS: it is the window the docs promise, so a changed constant must fail here.
  const windowOpens = (s: Record<string, string>) => new Date(Date.parse(s.certificateNotAfter!) - 30 * 86_400_000);
  /** A connection mid-rotation: the current certificate, and a successor minted inside the window. */
  const rotating = async () => {
    const first = await withCert();
    const { secret } = await prepare(base, first, windowOpens(first));
    return { first, secret, at: windowOpens(first) };
  };

  /** Entra, as the tenant's app registration sees it: only `registered` thumbprints sign in. */
  const entra = (registered: string[], extra: Routes = {}) => {
    const rest = microsoft(extra);
    const signedWith: string[] = [];
    const fetchImpl: FetchLike = async (input, init) => {
      const body = String(init?.body ?? '');
      if (input.includes('/oauth2/v2.0/token')) {
        const assertion = new URLSearchParams(body).get('client_assertion') ?? '';
        const x5t = JSON.parse(Buffer.from(assertion.split('.')[0]!, 'base64url').toString())['x5t#S256'] as string;
        signedWith.push(x5t);
        const ok = registered.includes(x5t);
        const r = ok ? { status: 200, body: { access_token: `TOKEN-${x5t.slice(0, 6)}` } } : entraError([700027], 401)['/oauth2/v2.0/token']!;
        return { ok, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) } as never;
      }
      return rest.fetchImpl(input, init);
    };
    return { calls: rest.calls, signedWith, fetchImpl };
  };

  describe('when a successor is minted', () => {
    it('a save exactly 30 days before the end mints one beside the current, which keeps signing', async () => {
      const first = await withCert();
      const { secret, expiresAt } = await prepare(base, first, windowOpens(first));
      expect(secret.privateKey).toBe(first.privateKey);
      expect(secret.certificate).toBe(first.certificate);
      expect(secret.nextCertificate).toBeTruthy();
      expect(secret.nextCertificate).not.toBe(first.certificate);
      expect(await certificateMatchesKey(secret.nextCertificate!, secret.nextPrivateKey!)).toBe(true);
      // The deadline is still the current certificate's.
      expect(expiresAt).toBe(first.certificateNotAfter);
    });

    it('a save a millisecond before the window opens mints none', async () => {
      const first = await withCert();
      const { secret } = await prepare(base, first, new Date(windowOpens(first).getTime() - 1));
      expect(secret.nextCertificate).toBeUndefined();
      expect(secret.nextPrivateKey).toBeUndefined();
    });

    it("the rotate flag mints one outside the window, and is never stored; only 'yes' asks", async () => {
      const first = await withCert();
      const asked = (await prepare({ ...base, rotateCertificate: 'yes' }, first, NOW)).secret;
      expect(asked.nextCertificate).toBeTruthy();
      expect(asked.rotateCertificate).toBeUndefined();
      expect(asked.certificate).toBe(first.certificate);
      for (const v of ['true', ' yes', 'YES']) {
        const notAsked = (await prepare({ ...base, rotateCertificate: v }, first, NOW)).secret;
        expect(notAsked.nextCertificate).toBeUndefined();
        expect(notAsked.rotateCertificate).toBeUndefined();
      }
    });

    it('the rotate flag on a first save mints one certificate, not two', async () => {
      const { secret } = await prepare({ ...base, rotateCertificate: 'yes' }, undefined, NOW);
      expect(secret.certificate).toBeTruthy();
      expect(secret.nextCertificate).toBeUndefined();
    });

    it('a pending successor is kept, not re-minted, by another save or another rotate flag', async () => {
      const { secret, at } = await rotating();
      const again = (await prepare({ ...base, rotateCertificate: 'yes' }, secret, at)).secret;
      expect(again.nextCertificate).toBe(secret.nextCertificate);
      expect(again.nextPrivateKey).toBe(secret.nextPrivateKey);
      expect(again.certificate).toBe(secret.certificate);
    });

    it("never takes a successor from the caller, with or without one of ours pending", async () => {
      const first = await withCert();
      const attacker = { nextPrivateKey: 'ATTACKER', nextCertificate: 'ATTACKER', nextCertificateNotAfter: '2099-01-01T00:00:00Z' };
      const fresh = (await prepare({ ...base, ...attacker }, first, NOW)).secret;
      expect(fresh.nextPrivateKey).toBeUndefined();
      expect(fresh.nextCertificate).toBeUndefined();

      const { secret, at } = await rotating();
      const kept = (await prepare({ ...base, ...attacker }, secret, at)).secret;
      expect(kept.nextPrivateKey).toBe(secret.nextPrivateKey);
      expect(kept.nextCertificate).toBe(secret.nextCertificate);
    });

    it('a malformed successor is dropped and, inside the window, minted again', async () => {
      const { secret, at } = await rotating();
      const broken = { ...secret, nextCertificate: secret.certificate! }; // not the successor key's certificate
      const healed = (await prepare(base, broken, at)).secret;
      expect(healed.certificate).toBe(secret.certificate);
      expect(healed.nextCertificate).not.toBe(secret.certificate);
      expect(await certificateMatchesKey(healed.nextCertificate!, healed.nextPrivateKey!)).toBe(true);
    });

    it('switching to a client secret drops both keypairs', async () => {
      const { secret, at } = await rotating();
      const { secret: s, expiresAt } = await prepare({ ...base, clientSecret: 'S' }, secret, at);
      expect(Object.keys(s).filter((k) => /privateKey|certificate/i.test(k))).toEqual([]);
      expect(expiresAt).toBeNull();
    });
  });

  describe('when a successor is promoted', () => {
    it('a save promotes it once Entra accepts it, and drops the old key', async () => {
      const { first, secret, at } = await rotating();
      const ms = entra([await thumbprintS256(secret.nextCertificate!)]);
      const signIn = (s: Microsoft365Secret) => acquireToken(ms.fetchImpl, s, { now: at });
      const { secret: promoted, expiresAt } = await prepare(base, secret, at, signIn);
      expect(promoted.privateKey).toBe(secret.nextPrivateKey);
      expect(promoted.certificate).toBe(secret.nextCertificate);
      expect(promoted.certificateNotAfter).toBe(secret.nextCertificateNotAfter);
      expect(expiresAt).toBe(secret.nextCertificateNotAfter);
      expect(promoted.nextCertificate).toBeUndefined();
      expect(JSON.stringify(promoted)).not.toContain(first.privateKey!);
      // It asked with the successor, and only with it.
      expect(ms.signedWith).toEqual([await thumbprintS256(secret.nextCertificate!)]);
    });

    it('the hook the control plane registers (prepareMicrosoft365) promotes it too, through its own sign-in', async () => {
      const { secret, at } = await rotating();
      const ms = entra([await thumbprintS256(secret.nextCertificate!)]);
      const hook = prepareMicrosoft365({ fetch: ms.fetchImpl, now: () => at, commonName: 'x' });
      const { secret: promoted, expiresAt } = await hook(base, secret);
      expect(promoted.certificate).toBe(secret.nextCertificate);
      expect(promoted.privateKey).toBe(secret.nextPrivateKey);
      expect(promoted.nextCertificate).toBeUndefined();
      expect(expiresAt).toBe(secret.nextCertificateNotAfter);
      // It signed in with the successor, through the fetch it was built with.
      expect(ms.signedWith).toEqual([await thumbprintS256(secret.nextCertificate!)]);
    });

    it('the save that promotes mints no new successor, even with rotation asked for; the next save may', async () => {
      const { secret, at } = await rotating();
      const ms = entra([await thumbprintS256(secret.nextCertificate!)]);
      const signIn = (s: Microsoft365Secret) => acquireToken(ms.fetchImpl, s, { now: at });
      const promoted = (await prepare({ ...base, rotateCertificate: 'yes' }, secret, at, signIn)).secret;
      expect(promoted.certificate).toBe(secret.nextCertificate);
      expect(promoted.nextCertificate).toBeUndefined();
      // The same holds when a lapse promotes it.
      const lapsed = new Date(Date.parse(secret.certificateNotAfter!) + 1000);
      const byLapse = (await prepare({ ...base, rotateCertificate: 'yes' }, secret, lapsed)).secret;
      expect(byLapse.certificate).toBe(secret.nextCertificate);
      expect(byLapse.nextCertificate).toBeUndefined();
      // Asked for again on a later save, it is minted beside the promoted certificate.
      const later = (await prepare({ ...base, rotateCertificate: 'yes' }, promoted, at, signIn)).secret;
      expect(later.certificate).toBe(promoted.certificate);
      expect(later.nextCertificate).toBeTruthy();
    });

    it('a successor Entra refuses leaves both exactly as they were', async () => {
      const { secret, at } = await rotating();
      const ms = entra([await thumbprintS256(secret.certificate!)]);
      const { secret: after, expiresAt } = await prepare(base, secret, at, (s) => acquireToken(ms.fetchImpl, s, { now: at }));
      expect(after).toEqual(secret);
      expect(expiresAt).toBe(secret.certificateNotAfter);
    });

    it('an incomplete candidate mid-rotation is not asked about, and does not throw', async () => {
      const { secret, at } = await rotating();
      const { siteUrl: _missing, ...incomplete } = base;
      const after = await prepare(incomplete, secret, at, async () => {
        throw new Error('must not be asked');
      });
      expect(after.secret.certificate).toBe(secret.certificate);
      expect(after.secret.nextCertificate).toBe(secret.nextCertificate);
    });

    it('a sign-in that throws, or no sign-in at all, leaves both exactly as they were', async () => {
      const { secret, at } = await rotating();
      const threw = await prepare(base, secret, at, async () => {
        throw new Error('network down');
      });
      expect(threw.secret).toEqual(secret);
      expect((await prepare(base, secret, at)).secret).toEqual(secret);
    });

    it('once the current certificate has lapsed, the successor takes its place without asking', async () => {
      const { secret } = await rotating();
      const lapsed = new Date(Date.parse(secret.certificateNotAfter!) + 1000);
      const { secret: after, expiresAt } = await prepare(base, secret, lapsed, async () => {
        throw new Error('must not be asked');
      });
      expect(after.certificate).toBe(secret.nextCertificate);
      expect(after.privateKey).toBe(secret.nextPrivateKey);
      expect(after.nextCertificate).toBeUndefined();
      expect(expiresAt).toBe(secret.nextCertificateNotAfter);
    });
  });

  describe('signing in mid-rotation', () => {
    it('the current certificate signs while it is registered; the successor is not tried', async () => {
      const { secret, at } = await rotating();
      const ms = entra([await thumbprintS256(secret.certificate!)]);
      expect(await acquireToken(ms.fetchImpl, secret as Microsoft365Secret, { now: at })).toMatchObject({ ok: true });
      expect(ms.signedWith).toEqual([await thumbprintS256(secret.certificate!)]);
    });

    it('when the tenant has removed the current one, the successor signs', async () => {
      const { secret, at } = await rotating();
      const ms = entra([await thumbprintS256(secret.nextCertificate!)]);
      expect(await acquireToken(ms.fetchImpl, secret as Microsoft365Secret, { now: at })).toMatchObject({ ok: true });
      expect(ms.signedWith).toEqual([await thumbprintS256(secret.certificate!), await thumbprintS256(secret.nextCertificate!)]);
    });

    it("when neither is registered, the answer is the current certificate's", async () => {
      const { secret, at } = await rotating();
      const out = await acquireToken(entra([]).fetchImpl, secret as Microsoft365Secret, { now: at });
      expect(out).toMatchObject({ ok: false, refused: false });
      expect((out as { error: string }).error).toContain('not on the app registration yet');
    });

    it("a successor that fails differently never replaces the current certificate's answer", async () => {
      const { secret, at } = await rotating();
      let n = 0;
      const fetchImpl: FetchLike = async () => {
        const r = n++ === 0 ? entraError([700027], 401)['/oauth2/v2.0/token']! : { status: 400, body: { error: 'invalid_client', error_codes: [700016] } };
        return { ok: false, status: r.status, json: async () => r.body, text: async () => '' } as never;
      };
      const out = await acquireToken(fetchImpl, secret as Microsoft365Secret, { now: at });
      expect(n).toBe(2);
      expect(out).toMatchObject({ ok: false, refused: false });
      expect((out as { error: string }).error).toContain('not on the app registration yet');
    });

    it('a refusal other than "not registered" is not retried with the successor', async () => {
      const { secret, at } = await rotating();
      const ms = microsoft(entraError([700016]));
      expect(await acquireToken(ms.fetchImpl, secret as Microsoft365Secret, { now: at })).toMatchObject({ ok: false, refused: true });
      expect(ms.calls).toHaveLength(1);
    });

    it('after the current one lapses, only the successor signs', async () => {
      const { secret } = await rotating();
      const lapsed = new Date(Date.parse(secret.certificateNotAfter!) + 1000);
      const ms = entra([await thumbprintS256(secret.certificate!), await thumbprintS256(secret.nextCertificate!)]);
      expect(await acquireToken(ms.fetchImpl, secret as Microsoft365Secret, { now: lapsed })).toMatchObject({ ok: true });
      expect(ms.signedWith).toEqual([await thumbprintS256(secret.nextCertificate!)]);
    });
  });

  describe('what the connection shows mid-rotation', () => {
    it('the certificate route keeps the current certificate on top and adds the successor as next', async () => {
      const { secret } = await rotating();
      const cert = await microsoft365Certificate(hostWith(secret).host, conn);
      expect(new X509Certificate(cert!.pem).fingerprint.replace(/:/g, '')).toBe(cert!.thumbprint);
      expect(cert!.notAfter).toBe(secret.certificateNotAfter);
      expect(Buffer.from(cert!.next!.pem.replace(/-----[A-Z ]+-----|\n/g, ''), 'base64').toString('base64')).toBe(secret.nextCertificate);
      expect(new X509Certificate(cert!.next!.pem).fingerprint.replace(/:/g, '')).toBe(cert!.next!.thumbprint);
      expect(cert!.next!.notAfter).toBe(secret.nextCertificateNotAfter);
      // What the control plane serves is the contract's parse, which must keep `next`.
      expect(connectionCertificate.parse(cert)).toEqual(cert);
      expect(JSON.stringify(cert)).not.toContain(secret.nextPrivateKey!);

      const settled = await microsoft365Certificate(hostWith(await withCert()).host, conn);
      expect(settled).not.toHaveProperty('next');
    });

    it('the summary names both thumbprints and both ends, and no key', async () => {
      const { secret } = await rotating();
      const summary = await microsoft365CredentialSummary(hostWith(secret).host, conn);
      const field = (k: string) => summary.fields.find((f) => f.key === k)?.value;
      expect(field('nextCertificate')).toMatch(/^[0-9A-F]{40}$/);
      expect(field('nextCertificate')).not.toBe(field('certificate'));
      expect(field('nextCertificateNotAfter')).toBe(secret.nextCertificateNotAfter);
      expect(JSON.stringify(summary)).not.toContain(secret.nextPrivateKey!);
      expect(JSON.stringify(summary)).not.toContain(secret.privateKey!);
    });

    it('the probe stays ok on the current certificate and says the successor is not accepted yet — without marking the connection unhealthy', async () => {
      const { secret, at } = await rotating();
      const ms = entra([await thumbprintS256(secret.certificate!)], siteOk);
      const h = hostWith(secret);
      const p = await probeMicrosoft365Connection(h.host, conn, { fetch: ms.fetchImpl, now: () => at });
      expect(p.ok).toBe(true);
      expect(p.facts.find((f) => f.label === 'New certificate')?.value).toContain('not accepted yet');
      // Only the current certificate's calls are recorded as the connection's health, and all were fine.
      expect(h.uses.length).toBeGreaterThan(0);
      expect(h.uses.every((u) => u.ok)).toBe(true);
    });

    it('the probe says when the successor is on the app registration', async () => {
      const { secret, at } = await rotating();
      const ms = entra([await thumbprintS256(secret.certificate!), await thumbprintS256(secret.nextCertificate!)], siteOk);
      const p = await probeMicrosoft365Secret(secret, { fetch: ms.fetchImpl, now: () => at });
      expect(p.ok).toBe(true);
      expect(p.facts.find((f) => f.label === 'New certificate')?.value).toContain('on the app registration');
    });

    it('a send after the current certificate lapses goes out signed with the successor', async () => {
      const { secret } = await rotating();
      const lapsed = new Date(Date.parse(secret.certificateNotAfter!) + 1000);
      const ms = entra([await thumbprintS256(secret.nextCertificate!)], { '/sendMail': { status: 202, body: {} } });
      const sender = microsoft365MailSender({ fetch: ms.fetchImpl, now: () => lapsed });
      await sender.send(hostWith(secret).host, conn, mail());
      expect(ms.signedWith).toEqual([await thumbprintS256(secret.nextCertificate!)]);
      expect(ms.calls.some((c) => c.url.endsWith('/sendMail'))).toBe(true);
    });
  });
});

describe('sitePath', () => {
  it("maps a site URL onto Graph's host-and-path address", () => {
    expect(sitePath('https://acme.sharepoint.com/sites/Team/')).toBe('sites/acme.sharepoint.com:/sites/Team');
    expect(sitePath('https://acme.sharepoint.com')).toBe('sites/acme.sharepoint.com');
  });
});
