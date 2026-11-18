import { URLSearchParams } from 'node:url';
import { X509Certificate, constants, createPrivateKey, createSign, generateKeyPairSync, verify } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectionCertificate, type Connection } from '@substrat-run/contracts';
import type { FetchLike, ScopeHost } from '@substrat-run/kernel';
import {
  Microsoft365CertificateRefusal,
  generateCertificate,
  microsoft365Certificate,
  microsoft365CredentialSummary,
  prepareMicrosoft365Candidate,
  probeMicrosoft365Connection,
  probeMicrosoft365Secret,
  thumbprintS256,
} from '../src/index.js';
import { certificateMatchesKey } from '../src/x509.js';

/**
 * #3281: the owner's own certificate — a pair they generated, whose certificate their Entra admin
 * already uploaded. Every key here is generated at run time: none is committed, and none could be
 * (`lint:secret-literals` refuses a private key in a tracked file).
 */

const NOW = new Date('2026-11-18T12:00:00Z');
const DAY = 86_400_000;
const base = {
  tenantId: '11111111-2222-3333-4444-555555555555',
  clientId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  senders: 'noreply@acme.example',
  siteUrl: 'https://acme.sharepoint.com/sites/Team',
};
const conn = { id: '01CONN', tenantId: '01HZZZZZZZZZZZZZZZZZZZZZZZ', vertical: 'desk', provider: 'microsoft365' } as unknown as Connection;

/** An owner's pair as the files they hold: the key as PKCS#8 PEM, the certificate as PEM and as a DER `.cer`. */
async function ownerPair(opts: { now?: Date } = {}) {
  const minted = await generateCertificate({ commonName: 'acme-owner', now: opts.now ?? new Date(NOW.getTime() - 10 * DAY) });
  const keyObject = createPrivateKey({ key: Buffer.from(minted.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  const der = Buffer.from(minted.certificate, 'base64');
  return {
    minted,
    keyObject,
    keyPem: keyObject.export({ type: 'pkcs8', format: 'pem' }) as string,
    certPem: new X509Certificate(der).toString(),
    /** A binary `.cer` as the browser sends a file that is not text: its bytes, base64. */
    certDerBase64: der.toString('base64'),
  };
}

/** The candidate a door sends for "Use my own certificate". */
const own = (key: string, certificate: string, over: Record<string, string> = {}) => ({
  ...base,
  signInWith: 'own-certificate',
  ownPrivateKey: key,
  ownCertificate: certificate,
  ...over,
});

const prepare = (
  candidate: Record<string, string>,
  previous?: Record<string, string>,
  opts: { now?: Date; signIn?: Parameters<typeof prepareMicrosoft365Candidate>[2]['signIn'] } = {},
) => prepareMicrosoft365Candidate(candidate, previous, { now: opts.now ?? NOW, commonName: 'x', ...(opts.signIn ? { signIn: opts.signIn } : {}) });

/** Every 64-character body line of a PEM key, and its whole base64: what must appear nowhere. */
const keyMaterial = (pem: string, b64: string) => [...pem.split('\n').filter((l) => l.length === 64), b64.slice(0, 48)];
const expectNoKey = (haystack: unknown, material: string[]) => {
  const text = typeof haystack === 'string' ? haystack : JSON.stringify(haystack);
  for (const m of material) expect(text).not.toContain(m);
};

/** Re-sign a certificate's TBS with another key: what a certificate the owner's own CA issued looks like to us. */
function resignedBy(certificateBase64: string): string {
  const der = Buffer.from(certificateBase64, 'base64');
  const at = (pos: number) => {
    let len = der[pos + 1]!;
    let body = pos + 2;
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let i = 0; i < n; i++) len = len * 256 + der[body + i]!;
      body += n;
    }
    return { start: pos, body, end: body + len };
  };
  const outer = at(0);
  const tbs = at(outer.body);
  const alg = at(tbs.end);
  const ca = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const sig = createSign('sha256').update(der.subarray(tbs.start, tbs.end)).sign(ca);
  const len = (n: number) => (n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]));
  const tlv = (tag: number, body: Buffer) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
  const bits = tlv(0x03, Buffer.concat([Buffer.from([0]), sig]));
  return tlv(0x30, Buffer.concat([der.subarray(tbs.start, tbs.end), der.subarray(alg.start, alg.end), bits])).toString('base64');
}

/** Entra's token endpoint: only `registered` x5t#S256 thumbprints sign in. Records each assertion. */
function entra(registered: string[]) {
  const assertions: string[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    if (input.includes('/oauth2/v2.0/token')) {
      const assertion = new URLSearchParams(String(init?.body ?? '')).get('client_assertion') ?? '';
      assertions.push(assertion);
      const x5t = JSON.parse(Buffer.from(assertion.split('.')[0]!, 'base64url').toString())['x5t#S256'] as string;
      const ok = registered.includes(x5t);
      const body = ok
        ? { access_token: 'TOKEN' }
        : { error: 'invalid_client', error_description: 'AADSTS700027: nope', error_codes: [700027] };
      return { ok, status: ok ? 200 : 401, json: async () => body, text: async () => JSON.stringify(body) } as never;
    }
    const site = { id: 'acme.sharepoint.com,1,2', displayName: 'Team', webUrl: base.siteUrl };
    return { ok: true, status: 200, headers: new Headers(), json: async () => site, text: async () => JSON.stringify(site) } as never;
  };
  return { assertions, fetchImpl };
}

const hostWith = (secret: Record<string, string>) =>
  ({
    admin: {
      openConnection: async () => ({ ...conn, secret }),
      recordConnectionUse: async () => {},
      getConnectorState: async () => undefined,
      putConnectorState: async () => {},
      listConnectorState: async () => [],
    },
  }) as unknown as ScopeHost;

const refusalOf = async (p: Promise<unknown>) => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Microsoft365CertificateRefusal);
  expect((err as Microsoft365CertificateRefusal).status).toBe(422);
  return (err as Error).message;
};

afterEach(() => vi.restoreAllMocks());

describe("signing in with the owner's own certificate", () => {
  it('a matching pair is stored as the generated one is, marked supplied, and signs in against Entra', async () => {
    const pair = await ownerPair();
    const { secret, expiresAt } = await prepare(own(pair.keyPem, pair.certPem));
    // The key sealed as the generated path seals one: PKCS#8, base64. The certificate byte for byte.
    expect(secret.privateKey).toBe(pair.minted.privateKey);
    expect(secret.certificate).toBe(pair.minted.certificate);
    expect(secret.certificateNotAfter).toBe(pair.minted.notAfter);
    expect(secret.certificateSupplied).toBe('yes');
    expect(expiresAt).toBe(pair.minted.notAfter);
    // The instructions and the pair as given are not stored under any name.
    for (const k of ['signInWith', 'ownPrivateKey', 'ownCertificate', 'nextPrivateKey', 'clientSecret']) expect(secret).not.toHaveProperty(k);

    const ms = entra([await thumbprintS256(pair.minted.certificate)]);
    const probe = await probeMicrosoft365Secret(secret, { fetch: ms.fetchImpl, now: () => NOW });
    expect(probe).toMatchObject({ ok: true, accountLabel: 'Team' });
    expect(probe.facts).toContainEqual({ label: 'Signs in with', value: 'your own certificate' });
    // The assertion is signed by the owner's key, which the certificate Entra holds carries.
    const [h, c, sig] = ms.assertions[0]!.split('.');
    const signed = verify(
      'sha256',
      Buffer.from(`${h}.${c}`),
      { key: new X509Certificate(pair.certPem).publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
      Buffer.from(sig!, 'base64url'),
    );
    expect(signed).toBe(true);
  });

  it.each([
    ['a PKCS#1 key and a DER .cer', async (p: Awaited<ReturnType<typeof ownerPair>>) => [p.keyObject.export({ type: 'pkcs1', format: 'pem' }) as string, p.certDerBase64]],
    ['a combined PEM file, and a chain with the leaf first', async (p: Awaited<ReturnType<typeof ownerPair>>) => {
      const other = await ownerPair();
      return [`${p.certPem}${p.keyPem}`, `${p.certPem}${other.certPem}`];
    }],
    ['a binary DER key', async (p: Awaited<ReturnType<typeof ownerPair>>) => [p.minted.privateKey, p.certPem]],
  ])('accepts %s', async (_, files) => {
    const pair = await ownerPair();
    const [key, cert] = await files(pair);
    const { secret } = await prepare(own(key!, cert!));
    expect(secret.privateKey).toBe(pair.minted.privateKey);
    expect(secret.certificate).toBe(pair.minted.certificate);
  });

  it("a certificate another key signed (the owner's own CA) is taken, and kept on the next save", async () => {
    const pair = await ownerPair();
    const issued = resignedBy(pair.minted.certificate);
    // Not the shape the platform mints, so the generated path's own check would drop it…
    expect(await certificateMatchesKey(issued, pair.minted.privateKey)).toBe(false);
    const { secret } = await prepare(own(pair.keyPem, issued));
    expect(secret.certificate).toBe(issued);
    // …but a supplied pair is held only to being one key and its certificate.
    const again = await prepare({ ...base, senders: 'other@acme.example' }, secret);
    expect(again.secret.certificate).toBe(issued);
    expect(again.secret.certificateSupplied).toBe('yes');
  });

  it('a key that is not the certificate\'s is refused, naming the certificate\'s thumbprint and nothing of the key', async () => {
    const [mine, other] = [await ownerPair(), await ownerPair()];
    const message = await refusalOf(prepare(own(mine.keyPem, other.certPem)));
    expect(message).toContain('does not belong to this certificate');
    expect(message).toContain(new X509Certificate(other.certPem).fingerprint.replace(/:/g, ''));
    expectNoKey(message, keyMaterial(mine.keyPem, mine.minted.privateKey));
  });

  it.each([
    ['PKCS#8', { type: 'pkcs8' }],
    ['PKCS#1', { type: 'pkcs1' }],
  ] as const)('an encrypted %s key is refused, saying how to export it unencrypted', async (_, form) => {
    const pair = await ownerPair();
    const encrypted = pair.keyObject.export({ ...form, format: 'pem', cipher: 'aes-256-cbc', passphrase: 'owner-pw' }) as string;
    const message = await refusalOf(prepare(own(encrypted, pair.certPem)));
    expect(message).toContain('encrypted');
    expect(message).toContain('openssl pkcs8 -topk8 -nocrypt');
  });

  it.each([
    ['an EC key', () => generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, 'not an RSA key'],
    ['an EC key in SEC1 form', () => generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'sec1', format: 'pem' }) as string, 'not an RSA key'],
    ['a 1024-bit key', () => generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, '1024-bit'],
    ['nothing readable', () => 'not a key', 'could not be read'],
  ])('%s is refused', async (_, key, says) => {
    const pair = await ownerPair();
    expect(await refusalOf(prepare(own(key(), pair.certPem)))).toContain(says);
  });

  it('a TBSCertificate without its signature, or a validity date that does not exist, is not a certificate', async () => {
    const pair = await ownerPair();
    const der = Buffer.from(pair.minted.certificate, 'base64');
    // The outer sequence's first element alone, re-wrapped: what a hand-cut "certificate" might be.
    const lenBytes = der[1]! & 0x80 ? 2 + (der[1]! & 0x7f) : 2;
    const tbsLen = (der[lenBytes + 1]! & 0x80 ? 2 + (der[lenBytes + 1]! & 0x7f) : 2) +
      (der[lenBytes + 1]! & 0x80 ? der.readUIntBE(lenBytes + 2, der[lenBytes + 1]! & 0x7f) : der[lenBytes + 1]!);
    const tbs = der.subarray(lenBytes, lenBytes + tbsLen);
    const tbsOnly = Buffer.concat([Buffer.from([0x30, 0x82, tbs.length >> 8, tbs.length & 0xff]), tbs]).toString('base64');
    expect(await refusalOf(prepare(own(pair.keyPem, tbsOnly)))).toContain('the certificate could not be read');
    // notAfter as February 30th: the second UTCTime's month and day digits, rewritten in place.
    const times = [...der.entries()].filter(([i, b]) => b === 0x17 && der[i + 1] === 13).map(([i]) => i);
    const feb30 = Buffer.from(der);
    feb30.write('0230', times[1]! + 4, 'ascii');
    expect(await refusalOf(prepare(own(pair.keyPem, feb30.toString('base64'))))).toContain('the certificate could not be read');
  });

  it('the halves swapped, one missing, or an expired certificate are each refused in words', async () => {
    const pair = await ownerPair();
    expect(await refusalOf(prepare(own(pair.certPem, pair.certPem)))).toContain('holds a certificate, not a private key');
    expect(await refusalOf(prepare(own(pair.keyPem, pair.keyPem)))).toContain('holds a private key, not the certificate');
    expect(await refusalOf(prepare(own(pair.keyPem, '')))).toContain('the certificate is missing');
    const old = await ownerPair({ now: new Date(NOW.getTime() - 400 * DAY) });
    expect(await refusalOf(prepare(own(old.keyPem, old.certPem)))).toContain('expired on');
  });

  it('the key appears in no response, fact, summary, certificate view or log line', async () => {
    const pair = await ownerPair();
    const material = keyMaterial(pair.keyPem, pair.minted.privateKey);
    // The runtime's whole console, wider than the members the connector declares for itself.
    const out = console as unknown as Record<'log' | 'warn' | 'error', (...data: unknown[]) => void>;
    const logged = [vi.spyOn(out, 'log'), vi.spyOn(out, 'warn'), vi.spyOn(out, 'error')];
    const { secret } = await prepare(own(pair.keyPem, pair.certPem));
    const host = hostWith(secret);
    const ms = entra([]); // not uploaded yet: the inconclusive path, with its own words
    const outputs = [
      await probeMicrosoft365Secret(secret, { fetch: ms.fetchImpl, now: () => NOW }),
      await probeMicrosoft365Connection(host, conn, { fetch: ms.fetchImpl, now: () => NOW }),
      await microsoft365CredentialSummary(host, conn),
      await microsoft365Certificate(host, conn),
    ];
    expectNoKey(outputs, material);
    // Not on the app registration is a refusal for a pair the owner says Entra holds: saving it must
    // not replace a working credential (the relay refuses a refused probe before it writes).
    expect(outputs[0]).toMatchObject({ ok: false, refused: true });
    expect((outputs[0] as { error: string }).error).toContain('your certificate is not on this app registration');
    expectNoKey(logged.flatMap((s) => s.mock.calls), material);
  });

  it('the certificate view says it was supplied, and the summary says the platform does not renew it', async () => {
    const pair = await ownerPair();
    const { secret } = await prepare(own(pair.keyPem, pair.certPem));
    const view = connectionCertificate.parse(await microsoft365Certificate(hostWith(secret), conn));
    expect(view).toMatchObject({ supplied: true, notAfter: pair.minted.notAfter });
    expect(view.thumbprint).toBe(new X509Certificate(pair.certPem).fingerprint.replace(/:/g, ''));
    const summary = await microsoft365CredentialSummary(hostWith(secret), conn);
    expect(summary.fields.find((f) => f.key === 'certificateSupplied')!.value).toContain('does not renew it');
    // A generated certificate's view does not claim to be supplied.
    const generated = (await prepare(base)).secret;
    expect(await microsoft365Certificate(hostWith(generated), conn)).not.toHaveProperty('supplied');
  });
});

describe('a supplied certificate and the rotation', () => {
  const supplied = async () => {
    const pair = await ownerPair();
    return { pair, secret: (await prepare(own(pair.keyPem, pair.certPem))).secret };
  };
  const inWindow = (s: Record<string, string>) => new Date(Date.parse(s.certificateNotAfter!) - 10 * DAY);

  it('is never rotated: not in the window, not by the rotate flag, not by a save that names no method', async () => {
    const { secret } = await supplied();
    for (const candidate of [base, { ...base, rotateCertificate: 'yes' }, { ...base, signInWith: 'own-certificate', rotateCertificate: 'yes' }]) {
      const { secret: after, expiresAt } = await prepare(candidate, secret, { now: inWindow(secret) });
      expect(after.privateKey).toBe(secret.privateKey);
      expect(after.certificate).toBe(secret.certificate);
      expect(after.certificateSupplied).toBe('yes');
      expect(after.nextCertificate).toBeUndefined();
      expect(expiresAt).toBe(secret.certificateNotAfter);
    }
  });

  it('is replaced by a new supplied pair, at once', async () => {
    const { secret } = await supplied();
    const next = await ownerPair();
    const { secret: after } = await prepare(own(next.keyPem, next.certPem), secret);
    expect(after.certificate).toBe(next.minted.certificate);
    expect(after.certificateSupplied).toBe('yes');
  });

  it('switching to a generated certificate keeps the supplied one signing until Entra accepts the new one', async () => {
    const { secret } = await supplied();
    const asked = await prepare({ ...base, signInWith: 'certificate' }, secret);
    expect(asked.secret.certificate).toBe(secret.certificate);
    expect(asked.secret.certificateSupplied).toBe('yes');
    expect(asked.secret.nextCertificate).toBeTruthy();
    expect(asked.expiresAt).toBe(secret.certificateNotAfter);

    // Not uploaded yet: a save, with or without the method, keeps both as they are.
    const notYet = await prepare(base, asked.secret, { signIn: async () => ({ ok: false, refused: false, error: 'x' }) });
    expect(notYet.secret).toEqual(asked.secret);

    // Uploaded: the generated certificate takes over, no longer marked supplied, the owner's key gone.
    const promoted = await prepare({ ...base, signInWith: 'certificate' }, asked.secret, { signIn: async () => ({ ok: true, accessToken: 'T' }) });
    expect(promoted.secret.certificate).toBe(asked.secret.nextCertificate);
    expect(promoted.secret.privateKey).toBe(asked.secret.nextPrivateKey);
    expect(promoted.secret).not.toHaveProperty('certificateSupplied');
    expect(promoted.secret).not.toHaveProperty('nextCertificate');
  });

  it('once it lapses with no switch under way, a save naming no method refuses rather than minting one unasked', async () => {
    const { secret } = await supplied();
    const lapsed = new Date(Date.parse(secret.certificateNotAfter!) + 1000);
    for (const candidate of [base, { ...base, signInWith: 'own-certificate' }]) {
      expect(await refusalOf(prepare(candidate, secret, { now: lapsed }))).toContain('the certificate you supplied expired on');
    }
    // Named, the platform's certificate replaces it.
    const generated = await prepare({ ...base, signInWith: 'certificate' }, secret, { now: lapsed });
    expect(generated.secret).not.toHaveProperty('certificateSupplied');
    expect(generated.secret.certificate).not.toBe(secret.certificate);
  });

  it('once the supplied certificate lapses mid-switch, the generated one takes its place', async () => {
    const { secret } = await supplied();
    const asked = (await prepare({ ...base, signInWith: 'certificate' }, secret)).secret;
    const lapsed = new Date(Date.parse(secret.certificateNotAfter!) + 1000);
    // Before that save, Test connection already signs with the successor, and says so.
    const ms = entra([await thumbprintS256(asked.nextCertificate!)]);
    const probe = await probeMicrosoft365Secret(asked, { fetch: ms.fetchImpl, now: () => lapsed });
    expect(probe.facts).toContainEqual({ label: 'Signs in with', value: 'certificate' });
    const { secret: after } = await prepare(base, asked, { now: lapsed });
    expect(after.certificate).toBe(asked.nextCertificate);
    expect(after).not.toHaveProperty('certificateSupplied');
  });
});

describe('switching between the three sign-in methods', () => {
  it('generated → own: the own pair replaces the generated one, and a pending successor is dropped', async () => {
    const generated = (await prepare({ ...base, rotateCertificate: 'yes' })).secret;
    const withSuccessor = (await prepare({ ...base, rotateCertificate: 'yes' }, generated)).secret;
    expect(withSuccessor.nextCertificate).toBeTruthy();
    const pair = await ownerPair();
    const { secret } = await prepare(own(pair.keyPem, pair.certPem), withSuccessor);
    expect(secret.certificate).toBe(pair.minted.certificate);
    expect(secret).not.toHaveProperty('nextCertificate');
  });

  it('own → client secret stores no key; client secret → own stores the pair', async () => {
    const pair = await ownerPair();
    const mine = (await prepare(own(pair.keyPem, pair.certPem))).secret;
    const asSecret = await prepare({ ...base, signInWith: 'client-secret', clientSecret: 'S', ownPrivateKey: pair.keyPem }, mine);
    expect(asSecret.expiresAt).toBeNull();
    expect(Object.keys(asSecret.secret).sort()).toEqual([...Object.keys(base), 'clientSecret'].sort());
    const back = await prepare(own(pair.keyPem, pair.certPem), asSecret.secret);
    expect(back.secret.certificateSupplied).toBe('yes');
    expect(back.secret).not.toHaveProperty('clientSecret');
  });

  it('own with no pair keeps the stored one; with none stored it is refused', async () => {
    const pair = await ownerPair();
    const mine = (await prepare(own(pair.keyPem, pair.certPem))).secret;
    const kept = await prepare({ ...base, signInWith: 'own-certificate', senders: 'b@acme.example' }, mine);
    expect(kept.secret.privateKey).toBe(mine.privateKey);
    expect(kept.secret.senders).toBe('b@acme.example');
    const generated = (await prepare(base)).secret;
    expect(await refusalOf(prepare({ ...base, signInWith: 'own-certificate' }, generated))).toContain('holds none of yours');
  });

  it('a caller cannot mark a certificate supplied, ask for a client secret without one, or name another method', async () => {
    const generated = (await prepare({ ...base, certificateSupplied: 'yes' })).secret;
    expect(generated).not.toHaveProperty('certificateSupplied');
    expect(await refusalOf(prepare({ ...base, signInWith: 'client-secret' }))).toContain('give the client secret');
    expect(await refusalOf(prepare({ ...base, signInWith: 'password' }))).toContain('unknown sign-in method');
  });
});

describe('a client secret, named and kept (#3281)', () => {
  const withSecret = () =>
    prepare({ ...base, signInWith: 'client-secret', clientSecret: 'S1', clientSecretExpiresOn: '2027-05-31' });

  it("takes the end Entra shows as the connection's expiry, and shows it", async () => {
    const { secret, expiresAt } = await withSecret();
    expect(secret).toMatchObject({ clientSecret: 'S1', clientSecretExpiresAt: '2027-05-31T00:00:00.000Z' });
    expect(secret).not.toHaveProperty('clientSecretExpiresOn');
    expect(expiresAt).toBe('2027-05-31T00:00:00.000Z');
    const summary = await microsoft365CredentialSummary(hostWith(secret), conn);
    expect(summary.fields.find((f) => f.key === 'clientSecretExpiresAt')!.value).toBe('2027-05-31');
  });

  it('left empty on a save, the stored secret and its end are kept; a new date replaces the end', async () => {
    const { secret } = await withSecret();
    const kept = await prepare({ ...base, signInWith: 'client-secret', senders: 'b@acme.example' }, secret);
    expect(kept.secret).toMatchObject({ clientSecret: 'S1', clientSecretExpiresAt: secret.clientSecretExpiresAt, senders: 'b@acme.example' });
    expect(kept.expiresAt).toBe(secret.clientSecretExpiresAt);
    const later = await prepare({ ...base, signInWith: 'client-secret', clientSecretExpiresOn: '2027-12-01' }, secret);
    expect(later.expiresAt).toBe('2027-12-01T00:00:00.000Z');
  });

  it('a new secret without a date clears the end, which described the old one', async () => {
    const { secret } = await withSecret();
    const fresh = await prepare({ ...base, signInWith: 'client-secret', clientSecret: 'S2' }, secret);
    expect(fresh.secret).not.toHaveProperty('clientSecretExpiresAt');
    expect(fresh.expiresAt).toBeNull();
  });

  it('a save naming no method keeps the stored secret; only a named certificate replaces it', async () => {
    const { secret } = await withSecret();
    expect((await prepare(base, secret)).secret.clientSecret).toBe('S1');
    const switched = await prepare({ ...base, signInWith: 'certificate' }, secret);
    expect(switched.secret).not.toHaveProperty('clientSecret');
    expect(switched.secret).not.toHaveProperty('clientSecretExpiresAt');
    expect(switched.secret.certificate).toBeTruthy();
  });

  it('a date that is not one is refused, and a caller cannot write the stored end', async () => {
    for (const d of ['31/05/2027', '2027-02-30', 'soon']) {
      expect(await refusalOf(prepare({ ...base, signInWith: 'client-secret', clientSecret: 'S', clientSecretExpiresOn: d }))).toContain('YYYY-MM-DD');
    }
    const { secret } = await prepare({ ...base, signInWith: 'client-secret', clientSecret: 'S', clientSecretExpiresAt: '2099-01-01T00:00:00.000Z' });
    expect(secret).not.toHaveProperty('clientSecretExpiresAt');
  });
});
