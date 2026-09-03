import type { FetchLike } from '@substrat-run/kernel';

// Web-standard everywhere this runs; declared locally so the mock pulls in no platform typings.
declare const URL: new (input: string) => { pathname: string; search: string };
declare const URLSearchParams: new (init: string) => { get(name: string): string | null };
declare const btoa: (data: string) => string;

/**
 * Fortnox in memory — the token endpoint and the three REST reads, enough to run the
 * whole sweep without a provider account.
 *
 * **What a mock proves:** that our shape works — the client-credentials mint, the
 * latin1 decode, the year-overlap pick, the paging, the unchanged-hash skip.
 * **What it cannot prove:** that our reading of Fortnox's API is correct. The mock IS
 * our reading. Green here means *ready to check against a real company*, which is what
 * `test/live.test.ts` does when a credential is present.
 *
 * The one thing it models with real bytes rather than a convenient string is the SIE
 * response: {@link FortnoxMock.sieBytes} encodes to ISO-8859-1, so a connector that
 * forgot to decode explicitly fails here rather than in production with mangled
 * account names.
 */
export interface FortnoxMockOptions {
  clientId?: string;
  clientSecret?: string;
  tenantId?: string;
  company?: { CompanyName: string; OrganizationNumber: string; DatabaseNumber: number };
  financialYears?: { Id: number; FromDate: string; ToDate: string }[];
  /** SIE4 text per financial-year id. */
  sie?: Record<number, string>;
  /** Seconds a minted token claims to live. */
  expiresIn?: number;
  /**
   * The one-time consent code the authorization-code exchange accepts — what a
   * consent-flow test (`completeFortnoxConsent`) presents. SINGLE-use, as Fortnox's
   * is: the second exchange of the same code answers `invalid_grant`, which is the
   * reloaded-callback-tab case a connect flow must survive.
   */
  consentCode?: string;
}

/** Encode to ISO-8859-1. Any code point above 0xff becomes `?`, exactly as Fortnox would. */
export function latin1Bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    out[i] = code <= 0xff ? code : 0x3f;
  }
  return out;
}

export class FortnoxMock {
  readonly apiBase = 'https://api.fortnox.test/3';
  readonly oauthBase = 'https://apps.fortnox.test/oauth-v1';

  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly tenantId: string;
  private readonly company: NonNullable<FortnoxMockOptions['company']>;
  private readonly years: NonNullable<FortnoxMockOptions['financialYears']>;
  private readonly sie: Record<number, string>;
  private readonly expiresIn: number;
  /** Spends to `undefined` on the first successful exchange. */
  private consentCode: string | undefined;

  /** Every token this mock has minted — a test asserts the mint happened exactly once. */
  readonly mints: string[] = [];
  /** Every REST path fetched, in order. */
  readonly calls: string[] = [];

  constructor(options: FortnoxMockOptions = {}) {
    this.clientId = options.clientId ?? 'client-id';
    this.clientSecret = options.clientSecret ?? 'client-secret';
    this.tenantId = options.tenantId ?? '123456';
    this.company = options.company ?? {
      CompanyName: 'Testbolaget AB',
      OrganizationNumber: '556677-8899',
      DatabaseNumber: 123456,
    };
    this.years = options.financialYears ?? [
      { Id: 1, FromDate: '2025-01-01', ToDate: '2025-12-31' },
      { Id: 2, FromDate: '2026-01-01', ToDate: '2026-12-31' },
    ];
    this.sie = options.sie ?? {};
    this.expiresIn = options.expiresIn ?? 3600;
    this.consentCode = options.consentCode;
  }

  /** Replace one year's SIE payload — how a test simulates "the books changed". */
  setSie(financialYearId: number, text: string): void {
    this.sie[financialYearId] = text;
  }

  private json(body: unknown, status = 200): Awaited<ReturnType<FetchLike>> {
    const text = JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
      arrayBuffer: async () => latin1Bytes(text).buffer as ArrayBuffer,
    } as Awaited<ReturnType<FetchLike>>;
  }

  /** The `fetch` a connector is handed. */
  readonly fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const path = url.pathname + url.search;

    if (path.endsWith('/oauth-v1/token')) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const auth = headers['Authorization'] ?? '';
      const expected = `Basic ${btoa(`${this.clientId}:${this.clientSecret}`)}`;
      if (auth !== expected) {
        return this.json({ error: 'invalid_client', error_description: 'bad client credentials' }, 401);
      }
      // The consent flow's one-time exchange: no TenantId header (the exchange is what
      // DISCOVERS the company), and the code spends on first use.
      if (String(init?.body ?? '').includes('grant_type=authorization_code')) {
        const code = new URLSearchParams(String(init?.body ?? '')).get('code') ?? undefined;
        if (this.consentCode === undefined || code !== this.consentCode) {
          return this.json({ error: 'invalid_grant', error_description: 'code spent or unknown' }, 400);
        }
        this.consentCode = undefined;
        const token = `consent-token-${this.mints.length + 1}`;
        this.mints.push(token);
        return this.json({
          access_token: token,
          token_type: 'bearer',
          expires_in: this.expiresIn,
          scope: 'bookkeeping companyinformation',
        });
      }
      if ((headers['TenantId'] ?? '') !== this.tenantId) {
        // Fortnox answers 400 here, not 404 — a wrong TenantId reads like a bad client
        // pair unless the message is surfaced, which is why the connector surfaces it.
        return this.json({ error: 'invalid_request', error_description: 'unknown tenant' }, 400);
      }
      if (!String(init?.body ?? '').includes('grant_type=client_credentials')) {
        return this.json({ error: 'unsupported_grant_type' }, 400);
      }
      const token = `token-${this.mints.length + 1}`;
      this.mints.push(token);
      return this.json({
        access_token: token,
        token_type: 'bearer',
        expires_in: this.expiresIn,
        scope: 'bookkeeping companyinformation',
      });
    }

    const headers = (init?.headers ?? {}) as Record<string, string>;
    const bearer = (headers['Authorization'] ?? '').replace(/^Bearer /, '');
    if (!this.mints.includes(bearer)) {
      return this.json({ ErrorInformation: { message: 'invalid token' } }, 401);
    }
    this.calls.push(path);

    if (path.endsWith('/companyinformation')) {
      return this.json({ CompanyInformation: this.company });
    }
    if (path.endsWith('/financialyears')) {
      return this.json({ FinancialYears: this.years });
    }
    const sieMatch = /\/sie\/4\?financialyear=(\d+)$/.exec(path);
    if (sieMatch) {
      const id = Number(sieMatch[1]);
      const text = this.sie[id];
      if (text === undefined) {
        return this.json({ ErrorInformation: { message: 'no such financial year' } }, 404);
      }
      const bytes = latin1Bytes(text);
      return {
        ok: true,
        status: 200,
        text: async () => text,
        arrayBuffer: async () => bytes.buffer as ArrayBuffer,
      } as Awaited<ReturnType<FetchLike>>;
    }
    return this.json({ ErrorInformation: { message: `unmocked path ${path}` } }, 404);
  };
}
