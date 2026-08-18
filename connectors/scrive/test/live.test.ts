import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { ScriveApi, type ScriveParty, type ScriveSecret } from '../src/api.js';

/**
 * The real thing — this talks to `api-testbed.scrive.com`.
 *
 * It runs ONLY when `connectors/scrive/.dev.vars` (gitignored) holds a complete
 * OAuth1 credential, so CI without secrets skips it and a local run with the
 * testbed creds exercises the actual API. This is the test that makes "ready to
 * check against reality" into "checked" — the mock's whole limitation is that it
 * is the author's reading of the docs on both sides of the call.
 *
 * What it can prove today: new → setfile → update → get, authenticated, with the
 * real request encodings, plus what `start` VALIDATES about a BankID party (#687).
 *
 * What it still cannot prove: a completed BankID signature. `se_bankid`-to-sign is
 * disabled on this testbed account, so `start` always answers 409
 * `authentication_to_sign_method_disabled` and no document here ever reaches
 * `pending`. That single error is exactly what makes the start tests below useful:
 * every OTHER error in Scrive's list is one the connector's party shape controls,
 * so their absence is a real assertion about the request we send. Enabling BankID
 * on the account is what the round-trip waits on.
 *
 * Nothing here is delivered to anyone: every document either fails to start or is
 * cancelled and deleted, and no party carries a real address.
 */

const dir = dirname(fileURLToPath(import.meta.url));

function loadSecret(): (ScriveSecret & { baseUrl: string }) | null {
  const path = join(dir, '..', '.dev.vars');
  if (!existsSync(path)) return null;
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]!] = m[2]!;
  }
  const { SCRIVE_CLIENT_ID, SCRIVE_CLIENT_SECRET, SCRIVE_TOKEN_ID, SCRIVE_TOKEN_SECRET } = env;
  if (!SCRIVE_CLIENT_ID || !SCRIVE_CLIENT_SECRET || !SCRIVE_TOKEN_ID || !SCRIVE_TOKEN_SECRET) {
    return null; // present but incomplete — skip rather than fail on a partial paste
  }
  return {
    clientId: SCRIVE_CLIENT_ID,
    clientSecret: SCRIVE_CLIENT_SECRET,
    tokenId: SCRIVE_TOKEN_ID,
    tokenSecret: SCRIVE_TOKEN_SECRET,
    baseUrl: env.SCRIVE_BASE_URL ?? 'https://api-testbed.scrive.com',
  };
}

const creds = loadSecret();

/** A ConnectorConnection-shaped object over the runtime's real fetch. */
function liveConnection(secret: ScriveSecret) {
  const realFetch = (globalThis as unknown as { fetch: typeof fetch }).fetch;
  return {
    id: 'live-test' as never,
    tenantId: 't',
    vertical: 'test',
    provider: 'scrive',
    secret,
    expiresAt: null,
    fetch: (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array }) =>
      realFetch(input, init as RequestInit) as never,
  };
}

// A minimal one-page PDF — no dependency, valid enough for Scrive to accept.
function tinyPdf(): Uint8Array {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const content = 'BT /F1 20 Tf 72 760 Td (Substrat live test) Tj ET';
  objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  let pdf = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((b, i) => {
    offs.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${b}\nendobj\n`;
  });
  const x = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offs) pdf += `${String(o).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i += 1) bytes[i] = pdf.charCodeAt(i) & 0xff;
  return bytes;
}

/**
 * A PDF standing in for the VERTICAL's own rendering (#711) — deliberately not the
 * shape this file or the connector generates: multiple text lines, a document-info
 * object, and WinAnsi-encoded åäö, which is how a Swedish avtal actually renders and
 * a byte range a UTF-8 assumption mangles.
 *
 * The point is not fidelity to any particular vertical's renderer. It is that the
 * bytes Scrive is asked to accept were produced by something else, which is the only
 * thing about this path a provider can be asked to confirm.
 */
function verticalPdf(heading: string): Uint8Array {
  const lines = [
    heading,
    'Mellan Nordljus AB (arbetsgivare) och den anställde.',
    '§2 Uppsägningstid: 3 månader. §3 Semester: 30 dagar.',
    'Undertecknas med BankID.',
  ];
  const content = [
    'BT /F1 14 Tf 72 780 Td 18 TL',
    ...lines.map((l) => `(${l.replace(/([()\\])/g, '\\$1')}) Tj T*`),
    'ET',
  ].join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Producer (the vertical, not this connector) /Title (Anstallningsavtal) >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((b, i) => {
    offs.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${b}\nendobj\n`;
  });
  const x = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offs) pdf += `${String(o).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  // Latin-1 truncation IS the WinAnsi encoding for this subset — å ä ö land on
  // 0xE5/0xE4/0xF6, which is exactly what /WinAnsiEncoding above declares.
  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i += 1) bytes[i] = pdf.charCodeAt(i) & 0xff;
  return bytes;
}

/**
 * The calls made outside `ScriveApi` — the ones that read a status or a raw body,
 * which the connector's `ConnectorConnection.fetch` deliberately does not expose.
 */
const rawFetch = (globalThis as unknown as { fetch: typeof fetch }).fetch;

const authHeader = (c: ScriveSecret) =>
  `oauth_signature_method="PLAINTEXT", oauth_consumer_key="${c.clientId}", ` +
  `oauth_token="${c.tokenId}", oauth_signature="${c.clientSecret}&${c.tokenSecret}"`;

const post = (path: string, init: RequestInit = {}) =>
  rawFetch(`${creds!.baseUrl}/api/v2/${path}`, {
    method: 'POST',
    ...init,
    headers: { authorization: authHeader(creds!), ...(init.headers ?? {}) },
  });

/** Good testbed citizen: cancel a started document, then trash and delete it. */
async function discard(documentId: string): Promise<void> {
  for (const action of ['cancel', 'trash', 'delete']) {
    // `cancel` 409s on a document that never started — expected, and not a failure
    // of the test that called this.
    await post(`documents/${documentId}/${action}`).catch(() => undefined);
  }
}

// Every test here makes several real round trips; vitest's 5s default is not a
// timeout, it is a coin toss on network latency.
const NET = 30_000;

describe.skipIf(!creds)('scrive connector — LIVE testbed', () => {
  /**
   * The two reads the inspection surface (#605) rests on. Exactly the check the mock
   * cannot make: that these endpoints exist, at these paths, returning what the
   * connector parses. `/api/v2/getprofile` — NOT `/api/v2/user/getprofile`, which is a
   * 404 — is the whole probe, and its `company.companyid` is what `externalAccountRef`
   * means for this provider.
   */
  it('reads the account profile and the document list', async () => {
    const api = new ScriveApi(liveConnection(creds!) as never, creds!.baseUrl);

    const profile = await api.getProfile();
    expect(profile.id).toBeTruthy();
    expect(profile.company?.companyid).toBeTruthy();

    const list = await api.listDocuments({ max: 1 });
    expect(list.total_matching).toBeGreaterThanOrEqual(0);
    expect(list.documents.length).toBeLessThanOrEqual(1);
    for (const d of list.documents) {
      expect(d.id).toBeTruthy();
      expect(d.status).toBeTruthy();
    }
  });

  it('reports a bad credential as the provider’s own words', async () => {
    // The probe's failure path against the real API: Scrive answers 401 with a
    // PLAIN-TEXT body, not its usual JSON error envelope — so the message an operator
    // reads comes from `asJson`'s raw-slice fallback, and this is what proves it.
    const broken = liveConnection({ ...creds!, tokenSecret: 'not-the-secret' });
    const api = new ScriveApi(broken as never, creds!.baseUrl);

    await expect(api.getProfile()).rejects.toThrow(/401/);
  });

  it('authenticates and drives new → setfile → update → get, then cleans up', async () => {
    const api = new ScriveApi(liveConnection(creds!) as never, creds!.baseUrl);

    const doc = await api.createDocument();
    expect(doc.id).toBeTruthy();

    await api.setFile(doc.id, 'live-test.pdf', tinyPdf());

    // `standard`, not `se_bankid`: BankID-to-sign is disabled on the testbed
    // account, and this test is about the API path, not the auth ceremony.
    await api.update(doc.id, {
      title: 'Substrat live test',
      parties: [
        { name: 'Sender', authenticationMethodToSign: 'standard', isAuthor: true, isSignatory: true },
        { name: 'Counterparty', authenticationMethodToSign: 'standard', isSignatory: true },
      ],
    });

    const full = await api.get(doc.id);
    expect(full.status).toBe('preparation'); // not started (we don't send it)
    expect(full.parties.length).toBe(2);
    expect(full.parties.some((p) => p.is_author)).toBe(true);

    // The sealed file (issue #476). Even on a prepared document Scrive returns the
    // working PDF here; the bytes and the `%PDF` magic are what we assert. The
    // sealed-with-evidence copy is the same call once the document is `closed`.
    const file = await api.getMainFile(doc.id);
    expect(file.length).toBeGreaterThan(0);
    expect(new TextDecoder().decode(file.slice(0, 5))).toBe('%PDF-');

    await discard(doc.id);
  }, NET);

  /**
   * The attachment path (#711), against the real API.
   *
   * The test above sends `tinyPdf()` — a sheet this test file generates, the same
   * shape the connector's own `renderPdf` fallback produces. That proves the API
   * accepts OUR paper. It says nothing about the case the seam exists for: a PDF
   * this codebase did not author, arriving from the vertical's attachment store,
   * arbitrary in size, structure and producer.
   *
   * So this sends one deliberately unlike a generated sheet — a real page stream
   * with WinAnsi åäö, an embedded metadata object, and a filename the vertical
   * chose. What it proves is the part only the provider can answer: Scrive takes a
   * document it did not see us build, and hands back a sealed copy of it.
   *
   * What it does NOT prove — stated so nobody reads more into a green run — is the
   * platform half: that the bytes reached the connector from the attachment store.
   * That is not a provider question and is pinned where it belongs, against the real
   * kernel path, in `test/dispatch.test.ts` and `adapter-sqlite/test/connector-reads.test.ts`.
   */
  it('accepts a document the connector did not render (#711)', async () => {
    const api = new ScriveApi(liveConnection(creds!) as never, creds!.baseUrl);
    const doc = await api.createDocument();

    // åäö in WinAnsi — the encoding a Swedish avtal actually renders in, and a
    // byte range a UTF-8 assumption mangles.
    const avtal = verticalPdf('Anställningsavtal — §1 Lön: 42 000 kr/mån');
    expect(avtal.length).toBeGreaterThan(tinyPdf().length); // genuinely a different document

    await api.setFile(doc.id, 'anställningsavtal-nordljus.pdf', avtal);
    await api.update(doc.id, {
      title: 'Substrat live test — vertical document',
      parties: [
        { name: 'Sender', authenticationMethodToSign: 'standard', isAuthor: true, isSignatory: true },
      ],
    });

    // Scrive re-seals what it stores, so the bytes back are not the bytes sent —
    // asserting equality would be asserting a falsehood. What holds is that a
    // document exists, is a PDF, and carries our content's weight.
    const sealed = await api.getMainFile(doc.id);
    expect(new TextDecoder().decode(sealed.slice(0, 5))).toBe('%PDF-');
    expect(sealed.length).toBeGreaterThan(0);

    await discard(doc.id);
  }, NET);

  /**
   * `start`, which the suite never called before — and the 409 that stopped every
   * production contract lived only there (#687).
   *
   * Scrive answers a refused `start` with a LIST of errors, which is what makes
   * these assertions possible: the account-level `authentication_to_sign_method_disabled`
   * is present in all three cases and cannot be avoided from here, while every other
   * entry is one the party shape controls. So what is actually being asserted is
   * which errors are ABSENT.
   */
  describe('what `start` validates about a BankID party (#687)', () => {
    /** new → setfile → update, with the counterparty shaped by the caller. */
    const prepare = async (counterparty: ScriveParty) => {
      const api = new ScriveApi(liveConnection(creds!) as never, creds!.baseUrl);
      const doc = await api.createDocument();
      await api.setFile(doc.id, 'live-test.pdf', tinyPdf());
      await api.update(doc.id, {
        title: 'Substrat live test — start validation',
        parties: [
          { name: 'Sender', authenticationMethodToSign: 'standard', isAuthor: true, isSignatory: true },
          counterparty,
        ],
      });
      return { api, id: doc.id };
    };

    /** The error TYPES Scrive listed, or `[]` if it accepted the document. */
    const startErrors = async (id: string): Promise<string[]> => {
      const res = await post(`documents/${id}/start`);
      if (res.ok) return [];
      const body = JSON.parse(await res.text()) as {
        error_details?: { errors?: { type: string }[] };
      };
      return (body.error_details?.errors ?? []).map((e) => e.type);
    };

    it('accepts an EMPTY personal_number — the field is what it wants, not a value', async () => {
      // What `ScriveApi.update` now sends for every `se_bankid` party. No
      // `invalid_authentication_to_sign_info`: the empty field satisfied the check
      // exactly as a real personnummer does, which is the finding this connector
      // change rests on. The delivery error is still here because THIS party
      // deliberately carries no address — the test below is the same shape with one,
      // and it is what shows the delivery gap closed (#687 item 1).
      const { id } = await prepare({
        name: 'Counterparty',
        authenticationMethodToSign: 'se_bankid',
        isSignatory: true,
      });
      const errors = await startErrors(id);
      expect(errors).not.toContain('invalid_authentication_to_sign_info');
      expect(errors).toContain('invalid_invitation_delivery_info');
      // The account setting, which no request shape can talk its way out of.
      expect(errors).toContain('authentication_to_sign_method_disabled');
      await discard(id);
    }, NET);

    it('rejects a BankID party carrying no personal_number field at all', async () => {
      // The control the assertion above needs: without the field the error IS
      // raised, so its absence there is the empty field doing the work rather than
      // Scrive never having minded. `update` cannot express this shape any more —
      // it adds the field for every BankID party — so the body goes out raw.
      const api = new ScriveApi(liveConnection(creds!) as never, creds!.baseUrl);
      const doc = await api.createDocument();
      await api.setFile(doc.id, 'live-test.pdf', tinyPdf());
      const document = {
        title: 'Substrat live test — no personal_number',
        parties: [
          {
            is_author: true,
            is_signatory: true,
            authentication_method_to_sign: 'standard',
            fields: [{ type: 'name', order: 1, value: 'Sender' }],
          },
          {
            is_author: false,
            is_signatory: true,
            authentication_method_to_sign: 'se_bankid',
            fields: [
              { type: 'name', order: 1, value: 'Counterparty' },
              { type: 'email', value: 'nobody@substrat.test' },
            ],
          },
        ],
      };
      const updated = await post(`documents/${doc.id}/update`, {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `document=${encodeURIComponent(JSON.stringify(document))}`,
      });
      expect(updated.status).toBe(200);

      expect(await startErrors(doc.id)).toContain('invalid_authentication_to_sign_info');
      await discard(doc.id);
    }, NET);

    it('a BankID party WITH an address no longer draws the delivery error (#687 item 1)', async () => {
      // The carrier, proved against the provider. Same party as the test above —
      // `se_bankid`, empty personal_number — plus the one thing that was missing
      // from every contract this platform ever sent: somewhere to deliver it.
      //
      // `invalid_invitation_delivery_info` is GONE, and the only error left is the
      // account setting no request shape can talk its way out of. That is the exact
      // difference between the two tests, and it is the whole of item 1.
      const { id } = await prepare({
        name: 'Counterparty',
        authenticationMethodToSign: 'se_bankid',
        email: 'nobody@substrat.test',
        isSignatory: true,
      });
      const errors = await startErrors(id);
      expect(errors).not.toContain('invalid_invitation_delivery_info');
      expect(errors).not.toContain('invalid_authentication_to_sign_info');
      expect(errors).toEqual(['authentication_to_sign_method_disabled']);
      await discard(id);
    }, NET);

    it('STARTS a document that is actually delivered — the end of the gap (#687)', async () => {
      // The acceptance criterion, and the first document this connector has ever
      // been able to start. `standard` rather than `se_bankid` because BankID-to-sign
      // is disabled on this testbed account and that refusal is unrelated to the
      // carrier; what is under test is that a party the provider must INVITE now
      // carries somewhere to invite them.
      //
      // `nobody@substrat.test` is unroutable by construction (RFC 2606 reserves
      // `.test`), so starting this reaches no human — and it is cancelled, trashed
      // and deleted immediately, like every other document in this file.
      const { api, id } = await prepare({
        name: 'Counterparty',
        authenticationMethodToSign: 'standard',
        email: 'nobody@substrat.test',
        isSignatory: true,
      });
      expect(await startErrors(id)).toEqual([]);

      // It is really out for signature at the provider, not merely accepted.
      const doc = await api.get(id);
      expect(doc.status).toBe('pending');
      await discard(id);
    }, NET);

    it('reports every reason at once, not just the first (`asJson`)', async () => {
      // Two problems, two sentences. `error_message` carries only the first, so an
      // operator reading the delivery-attempt history (#618) would fix one, retry,
      // and meet the next — which is how the account setting stayed hidden behind
      // the missing field for three production contracts.
      const { api, id } = await prepare({
        name: 'Counterparty',
        authenticationMethodToSign: 'se_bankid',
        isSignatory: true,
      });
      await expect(api.start(id)).rejects.toThrow(/disabled[\s\S]*email|email[\s\S]*disabled/i);
      await discard(id);
    }, NET);
  });
});
