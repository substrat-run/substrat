import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { connectionId } from '@substrat-run/contracts';
import type { ConnectorConnection } from '@substrat-run/kernel';
import { FortnoxApi, type FortnoxSecret } from '../src/api.js';
import { financialYearFor, summarizeLedger } from '../src/aggregate.js';
import { parseSie4 } from '../src/sie4.js';
import { loadDevSecrets, providerEnv } from '../scripts/dev-secrets.mjs';

/**
 * The real thing — this talks to `api.fortnox.se`.
 *
 * It runs ONLY when `secrets/connectors.env` (or this package's legacy `.dev.vars`, both
 * gitignored) or the `FORTNOX_*` environment holds a complete client-credentials triple,
 * so CI without secrets skips it
 * and a local run against a real company exercises the actual API. This is the test that turns "ready to check
 * against reality" into "checked" — the mock's whole limitation is that it is the
 * author's reading of the docs on both sides of the call.
 *
 * **Read-only.** The data calls are GETs; the one POST is the token mint, which creates
 * no Fortnox record. This connector has no write path to Fortnox at all, so there is no
 * cleanup to do and nothing it can damage in a live company's books — which is what makes
 * running it against production data acceptable.
 *
 * What it proves, and what only a live call can:
 *
 * 1. `grant_type=client_credentials` with a `TenantId` header actually mints, which is
 *    the claim this connector's whole credential model rests on. If Fortnox required
 *    the authorization-code flow here, everything else is wrong.
 * 2. The SIE4 response's real charset. The mock asserts our HANDLING; only this asserts
 *    the premise — and the premise was wrong: it is PC8/CP437, not ISO-8859-1.
 * 3. `financialyears` and `sie/4` return the documented shapes, under the response
 *    envelopes (`FinancialYears`, `CompanyInformation`) the parsers unwrap.
 */

const dir = dirname(fileURLToPath(import.meta.url));

function loadSecret(): FortnoxSecret | null {
  // One file for every connector — see `scripts/dev-secrets.mts` for why this is not
  // `secrets/platform.<env>.env`. The package's own `.dev.vars` still works as a fallback,
  // and `FORTNOX_*` in the environment wins over both, so a CI job holding the credential
  // in its secret store needs no file at all.
  const env = {
    ...loadDevSecrets(
      join(dir, '..', '..', '..', 'secrets', 'connectors.env'),
      join(dir, '..', '.dev.vars'),
    ),
    ...providerEnv('FORTNOX_'),
  };
  const { FORTNOX_CLIENT_ID, FORTNOX_CLIENT_SECRET, FORTNOX_TENANT_ID } = env;
  // Present but incomplete — skip rather than fail on a partial paste.
  if (!FORTNOX_CLIENT_ID || !FORTNOX_CLIENT_SECRET || !FORTNOX_TENANT_ID) return null;
  return {
    clientId: FORTNOX_CLIENT_ID,
    clientSecret: FORTNOX_CLIENT_SECRET,
    tenantId: FORTNOX_TENANT_ID,
  };
}

const secret = loadSecret();

/** A bare connection — no directory, no health recording; this is an API check. */
const connectionFor = (s: FortnoxSecret): ConnectorConnection => ({
  id: connectionId.parse('00000000000000000000000000'),
  tenantId: '',
  vertical: '',
  provider: 'fortnox',
  secret: s,
  expiresAt: null,
  fetch: (input, init) => fetch(input, init as RequestInit) as never,
});

describe.skipIf(secret === null)('fortnox connector — live API', () => {
  const api = new FortnoxApi(connectionFor(secret!));

  it('mints an access token with grant_type=client_credentials', async () => {
    const token = await api.accessToken();
    expect(token.length).toBeGreaterThan(10);
    // Minted once and cached for the instance — a second call spends no round trip.
    expect(await api.accessToken()).toBe(token);
  });

  it('reads the company, and its DatabaseNumber matches the TenantId we authenticated with', async () => {
    const company = await api.companyInformation();
    expect(company.CompanyName).not.toBe('');
    // If these disagree, the connection is keyed to a different company than it is
    // reading — the single most consequential thing to get wrong in this credential.
    if (company.DatabaseNumber !== undefined) {
      expect(String(company.DatabaseNumber)).toBe(secret!.tenantId);
    }
  });

  it('lists financial years in the documented shape', async () => {
    const years = await api.financialYears();
    expect(years.length).toBeGreaterThan(0);
    for (const y of years) {
      expect(y.FromDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(y.ToDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('downloads SIE4 as PC8/CP437 and parses into a ledger that balances', async () => {
    const years = await api.financialYears();
    const latest = years.sort((a, b) => (a.FromDate < b.FromDate ? 1 : -1))[0]!;
    const sie = await api.sieFile(latest.Id);

    // The format marker Fortnox writes. Its absence means we are looking at an error
    // page or a differently-encoded body, not a SIE file.
    expect(sie).toContain('#SIETYP');

    const ledger = parseSie4(sie);
    expect(ledger.accounts.length).toBeGreaterThan(0);

    // The charset proof. The previous version of this check looked for U+FFFD and
    // COULD NOT FAIL: every byte 0x00–0xFF is a valid latin1 code point, so decoding
    // CP437 as latin1 produces no replacement character — it produced `f”r` for `för`
    // and the assertion passed. These three can each actually fail.
    const names = ledger.accounts.map((a) => a.name).join(' ');
    expect(names).not.toContain('�');
    // A C1 control in an account name means high bytes were read with the wrong table.
    // Correctly decoded Swedish text contains none.
    expect(names).not.toMatch(/[\u0080-\u009f]/);
    // And positively: a Swedish chart of accounts HAS these letters. Without this, a
    // decoder that dropped every high byte would still satisfy both checks above.
    expect(names).toMatch(/[\u00e5\u00e4\u00f6\u00c5\u00c4\u00d6]/);

    // Double-entry: every voucher's rows sum to zero. This is the strongest available
    // check that the amount column was read from the right field — an off-by-one in the
    // field split (the `{}` object-list trap) breaks it immediately.
    for (const voucher of ledger.vouchers.slice(0, 200)) {
      const total = voucher.transactions.reduce((sum, t) => sum + Number(t.amount), 0);
      expect(Math.abs(total)).toBeLessThan(0.005);
    }
  });

  it('picks a financial year by overlap and summarizes it', async () => {
    const years = await api.financialYears();
    const latest = years.sort((a, b) => (a.FromDate < b.FromDate ? 1 : -1))[0]!;
    // Deliberately a period that only OVERLAPS: the trap this rule exists for.
    const picked = financialYearFor(years, { from: latest.ToDate, to: '2099-12-31' });
    expect(picked?.Id).toBe(latest.Id);

    const summary = summarizeLedger(parseSie4(await api.sieFile(latest.Id)));
    expect(summary.currency).toMatch(/^[A-Z]{3}$/);
    for (const b of summary.balances) expect(b.month).toMatch(/^\d{4}-\d{2}$/);
  });
});
