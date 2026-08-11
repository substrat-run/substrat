import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { ScriveApi, type ScriveSecret } from '../src/api.js';

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
 * real request encodings. What it deliberately does NOT do: `start` with
 * `se_bankid`, because BankID-to-sign is disabled on the testbed account (start
 * returns 409). It uses `standard` auth so the lifecycle runs; the BankID
 * round-trip waits on that account setting.
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

    // Good testbed citizen: trash + delete via the real fetch.
    const conn = liveConnection(creds!);
    for (const action of ['trash', 'delete']) {
      await conn.fetch(`${creds!.baseUrl}/api/v2/documents/${doc.id}/${action}`, {
        method: 'POST',
        headers: {
          authorization:
            `oauth_signature_method="PLAINTEXT", oauth_consumer_key="${creds!.clientId}", ` +
            `oauth_token="${creds!.tokenId}", oauth_signature="${creds!.clientSecret}&${creds!.tokenSecret}"`,
        },
      });
    }
  });
});
