import type { FetchLike } from '@substrat-run/kernel';
import { CP437_HIGH } from './sie4.js';

// Web-standard everywhere this runs; declared locally so the mock pulls in no platform typings.
declare const URL: new (input: string) => { pathname: string; search: string };
declare const URLSearchParams: new (init: string) => { get(name: string): string | null };
declare const btoa: (data: string) => string;

/**
 * Fortnox in memory — the token endpoint and the REST reads the sweep makes, enough to run
 * it without a provider account.
 *
 * **What a mock proves:** that our shape works — the client-credentials mint, the
 * PC8/CP437 decode, the year-overlap pick, the paging, the unchanged-hash skip.
 * **What it cannot prove:** that our reading of Fortnox's API is correct. The mock IS
 * our reading. Green here means *ready to check against a real company*, which is what
 * `test/live.test.ts` does when a credential is present.
 *
 * The one thing it models with real bytes rather than a convenient string is the SIE
 * response: {@link FortnoxMock.sieBytes} encodes to PC8/CP437, so a connector that
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

/** A supplier invoice as the mock serves its detail, plus when it last changed (`YYYY-MM-DD HH:MM`, Swedish local). */
export interface FortnoxMockSupplierInvoice {
  invoice: { GivenNumber: string } & Record<string, unknown>;
  modified: string;
  /** Listed, but its detail answers 404: deleted between the list and the read. */
  gone?: boolean;
  /** The files connected to it, in the order `supplierinvoicefileconnections` lists them. */
  files?: { FileId: string; Name: string; bytes: Uint8Array; contentType?: string }[];
  /** Its comment log, oldest first. */
  comments?: string[];
  /** Why `bookkeep` answers 400, as Fortnox does for a locked period or a missing account. */
  cannotBook?: string;
}

/**
 * Encode to PC8 (code page 437) — the charset a real Fortnox SIE export declares in
 * `#FORMAT` and actually sends.
 *
 * This used to encode ISO-8859-1, and that single wrong premise is what let a wrong
 * decoder pass every test in this package: the mock encoded latin1, the reader decoded
 * latin1, and the two agreed with each other while disagreeing with Fortnox. Only the
 * live suite could see it. Encoding here the way the provider really does is what makes
 * the mock evidence about Fortnox rather than about our own assumption.
 *
 * A code point with no CP437 representation becomes `?`, exactly as Fortnox would.
 */
export function pc8Bytes(text: string): Uint8Array {
  // `for...of` iterates CODE POINTS; `text[i]` would hand back UTF-16 code units, so an
  // astral character (an emoji in a voucher text, say) would split into two surrogate
  // halves and emit two `?` bytes where the contract above promises one.
  const out: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0x3f;
    if (code < 0x80) {
      out.push(code);
      continue;
    }
    const high = CP437_HIGH.indexOf(ch);
    out.push(high === -1 ? 0x3f : 0x80 + high);
  }
  return new Uint8Array(out);
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
  /** Every write, in order, with its body: `method path` and what was sent. */
  readonly writes: { request: string; body?: unknown }[] = [];

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

  private readonly supplierInvoices = new Map<string, FortnoxMockSupplierInvoice>();

  /** REST requests still to be answered 429 with `Retry-After: 2`, counting down. */
  rateLimitNext = 0;
  /** Only requests whose path contains this count toward {@link rateLimitNext}. */
  rateLimitOn = '';
  /**
   * The scopes the company's consent left out — a request needing one answers 403, the same
   * way Fortnox tells a connection it never asked for `archive` or `connectfile`.
   */
  deniedScopes: string[] = [];

  /** Add or change a supplier invoice — how a test simulates "an invoice was booked". */
  setSupplierInvoice(entry: FortnoxMockSupplierInvoice): void {
    this.supplierInvoices.set(entry.invoice.GivenNumber, entry);
  }

  /** Replace one year's SIE payload — how a test simulates "the books changed". */
  setSie(financialYearId: number, text: string): void {
    this.sie[financialYearId] = text;
  }

  private json(body: unknown, status = 200, headers: Record<string, string> = {}): Awaited<ReturnType<FetchLike>> {
    const text = JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => headers[name] ?? null },
      text: async () => text,
      arrayBuffer: async () => pc8Bytes(text).buffer as ArrayBuffer,
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
          scope: 'bookkeeping companyinformation supplierinvoice archive connectfile',
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
        scope: 'bookkeeping companyinformation supplierinvoice archive connectfile',
      });
    }

    const headers = (init?.headers ?? {}) as Record<string, string>;
    const bearer = (headers['Authorization'] ?? '').replace(/^Bearer /, '');
    if (!this.mints.includes(bearer)) {
      return this.json({ ErrorInformation: { message: 'invalid token' } }, 401);
    }
    this.calls.push(path);
    if (this.rateLimitNext > 0 && path.includes(this.rateLimitOn)) {
      this.rateLimitNext -= 1;
      return this.json({ message: 'Too many requests' }, 429, { 'Retry-After': '2' });
    }

    if (init?.method !== undefined && init.method !== 'GET') {
      const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      this.writes.push({ request: `${init.method} ${url.pathname}`, ...(body === undefined ? {} : { body }) });
      return this.applyWrite(url.pathname, init.method, body);
    }

    if (path.endsWith('/companyinformation')) {
      return this.json({ CompanyInformation: this.company });
    }
    if (path.endsWith('/financialyears')) {
      return this.json({ FinancialYears: this.years });
    }
    if (url.pathname.endsWith('/supplierinvoices')) {
      // `lastmodified` is inclusive and to the minute, so string order is time order.
      const query = new URLSearchParams(url.search.slice(1));
      const since = query.get('lastmodified') ?? ''; // no filter: every invoice
      const limit = Number(query.get('limit') ?? 100);
      const page = Number(query.get('page') ?? 1);
      const matching = [...this.supplierInvoices.values()].filter((e) => e.modified >= since);
      return this.json({
        MetaInformation: { '@TotalPages': Math.max(1, Math.ceil(matching.length / limit)), '@CurrentPage': page },
        SupplierInvoices: matching
          .slice((page - 1) * limit, page * limit)
          .map((e) => ({ GivenNumber: e.invoice.GivenNumber })),
      });
    }
    const commentsMatch = /\/supplierinvoices\/([^/?]+)\/commentlog$/.exec(url.pathname);
    if (commentsMatch) {
      const entry = this.supplierInvoices.get(decodeURIComponent(commentsMatch[1]!));
      if (!entry) return this.json({ ErrorInformation: { message: 'no such supplier invoice' } }, 404);
      return this.json({ SupplierInvoiceCommentLog: (entry.comments ?? []).map((Comment) => ({ Comment })) });
    }
    const invoiceMatch = /\/supplierinvoices\/([^/?]+)$/.exec(url.pathname);
    if (invoiceMatch) {
      const entry = this.supplierInvoices.get(decodeURIComponent(invoiceMatch[1]!));
      if (!entry || entry.gone) return this.json({ ErrorInformation: { message: 'no such supplier invoice' } }, 404);
      return this.json({ SupplierInvoice: entry.invoice });
    }
    if (url.pathname.endsWith('/supplierinvoicefileconnections')) {
      if (this.deniedScopes.includes('connectfile')) return this.json({ ErrorInformation: { message: 'no access to scope' } }, 403);
      const number = new URLSearchParams(url.search.slice(1)).get('supplierinvoicenumber') ?? '';
      const files = this.supplierInvoices.get(number)?.files ?? [];
      return this.json({
        SupplierInvoiceFileConnections: files.map((f) => ({ FileId: f.FileId, Name: f.Name, SupplierInvoiceNumber: number })),
      });
    }
    const archiveMatch = /\/archive\/([^/?]+)$/.exec(url.pathname);
    if (archiveMatch) {
      if (this.deniedScopes.includes('archive')) return this.json({ ErrorInformation: { message: 'no access to scope' } }, 403);
      const fileId = decodeURIComponent(archiveMatch[1]!);
      const file = [...this.supplierInvoices.values()].flatMap((e) => e.files ?? []).find((f) => f.FileId === fileId);
      if (!file) return this.json({ ErrorInformation: { message: 'no such file' } }, 404);
      return {
        ok: true,
        status: 200,
        headers: { get: (name: string) => (name === 'Content-Type' ? (file.contentType ?? null) : null) },
        text: async () => '',
        arrayBuffer: async () => file.bytes.buffer as ArrayBuffer,
      } as Awaited<ReturnType<FetchLike>>;
    }
    const sieMatch = /\/sie\/4\?financialyear=(\d+)$/.exec(path);
    if (sieMatch) {
      const id = Number(sieMatch[1]);
      const text = this.sie[id];
      if (text === undefined) {
        return this.json({ ErrorInformation: { message: 'no such financial year' } }, 404);
      }
      const bytes = pc8Bytes(text);
      return {
        ok: true,
        status: 200,
        text: async () => text,
        arrayBuffer: async () => bytes.buffer as ArrayBuffer,
      } as Awaited<ReturnType<FetchLike>>;
    }
    return this.json({ ErrorInformation: { message: `unmocked path ${path}` } }, 404);
  };

  /** The three writes the invoice write-back makes. */
  private applyWrite(pathname: string, method: string, body: unknown): ReturnType<FetchLike> extends Promise<infer R> ? R : never {
    const match = /\/supplierinvoices\/([^/?]+)(?:\/(bookkeep|commentlog))?$/.exec(pathname);
    const entry = match ? this.supplierInvoices.get(decodeURIComponent(match[1]!)) : undefined;
    if (!match || !entry) return this.json({ ErrorInformation: { message: 'no such supplier invoice' } }, 404);
    if (match[2] === 'bookkeep' && method === 'PUT') {
      if (entry.cannotBook) return this.json({ ErrorInformation: { message: entry.cannotBook } }, 400);
      entry.invoice['Booked'] = true;
      return this.json({ SupplierInvoice: entry.invoice });
    }
    if (match[2] === 'commentlog' && method === 'POST') {
      const comment = (body as { SupplierInvoiceCommentLog: { Comment: string } }).SupplierInvoiceCommentLog.Comment;
      entry.comments = [...(entry.comments ?? []), comment];
      return this.json({ SupplierInvoiceCommentLog: { Comment: comment } }, 201);
    }
    if (match[2] === undefined && method === 'PUT') {
      Object.assign(entry.invoice, (body as { SupplierInvoice: Record<string, unknown> }).SupplierInvoice);
      return this.json({ SupplierInvoice: entry.invoice });
    }
    return this.json({ ErrorInformation: { message: `unmocked write ${method} ${pathname}` } }, 404);
  }
}
