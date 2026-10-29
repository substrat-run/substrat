import { z } from 'zod';
import {
  addDecimal,
  connectionActivity,
  connectionId as connectionIdSchema,
  instant,
  money,
  mulDecimal,
  scopeId as scopeIdSchema,
  tenantId as tenantIdSchema,
  type ConnectionActivity,
  type ConnectionCredential,
  type ConnectionProbe,
  type ConnectionId,
} from '@substrat-run/contracts';
import type {
  ConnectorConnection,
  FetchLike,
  HostAdmin,
  ScopeHost,
} from '@substrat-run/kernel';
import { deadlineFetch, settleConnectionUse } from '@substrat-run/kernel';
import {
  FortnoxApi,
  FortnoxApiError,
  FORTNOX_API_BASE,
  FORTNOX_OAUTH_BASE,
  fortnoxSecret,
} from './api.js';
import { financialYearFor, summarizeLedger } from './aggregate.js';
import { parseSie4 } from './sie4.js';

// Web-standard everywhere this runs (Node, Workers); declared locally so the
// connector pulls in no platform typings, exactly as `connector-scrive` does.
declare const AbortSignal: { timeout(ms: number): unknown };
declare const crypto: { subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> } };
declare const TextEncoder: new () => { encode(input: string): Uint8Array };

export {
  FortnoxApi,
  FortnoxApiError,
  FORTNOX_API_BASE,
  FORTNOX_OAUTH_BASE,
  fortnoxConsentUrl,
  fortnoxSecret,
  type FortnoxCompany,
  type FortnoxFinancialYear,
  type FortnoxSecret,
  type FortnoxSupplierInvoice,
} from './api.js';
export {
  parseSie4,
  splitSieLine,
  sieAmount,
  sieDate,
  type SieAccount,
  type SieDimension,
  type SieLedger,
  type SieObject,
  type SieTransaction,
  type SieVoucher,
} from './sie4.js';
export {
  COST_CENTRE_DIMENSION,
  financialYearFor,
  summarizeLedger,
  type LedgerBalance,
  type LedgerSummary,
} from './aggregate.js';
export { FortnoxMock, type FortnoxMockOptions, type FortnoxMockSupplierInvoice } from './mock.js';
export { completeFortnoxConsent, type FortnoxConsentCompletion } from './connect.js';

/**
 * The Fortnox connector — the INBOUND half of accounting integration.
 *
 * ## Poll-only, and that is a design fact rather than an omission
 *
 * `connector-scrive` has two halves: a dispatch handler driven by an engine event, and
 * a sweep that polls the provider. This connector has **only the sweep**, and registers
 * no event handler at all, because nothing inside a scope initiates the work. A
 * vertical does not *ask* for last month's bookkeeping the way it asks for a signature;
 * the bookkeeping simply changes at Fortnox, and the platform finds out by looking.
 *
 * So there is no `registerFortnoxConnector`. `sweepFortnoxLedger` is a
 * {@link ConnectorSweeper}, the deployment binds it into the platform sweeper exactly
 * as it binds Scrive's, and that is the whole trigger surface.
 *
 * ## Where the data lands, and why the connector does not decide
 *
 * A sweep has no delivered event, so it has neither a scope to write to nor authority
 * to write with. Scrive gets both from its dispatch ledger — the row it wrote when the
 * event arrived. This connector has no such moment, so the scope is declared **once**,
 * explicitly, by {@link bindFortnoxScope}: which scope, which operation to land the
 * ledger through, and which permission that operation checks.
 *
 * The operation is the *consumer's*, not this connector's, and that is deliberate. What
 * comes out of Fortnox is neutral accounting fact — accounts, cost centres, months,
 * debit-positive sums. What a business *means* by them (which account is
 * `lokal_grundhyra`, which sign normalizes it, which group it rolls into) is vocabulary,
 * and vocabulary is the vertical's layer. A connector that mapped accounts to row keys
 * would be a vertical wearing a connector's clothes, and the second customer with a
 * different chart of accounts would have to fork it.
 */

/**
 * The standing grants this connector requires — deliberately EMPTY, with a mechanism
 * in place of a declaration.
 *
 * Every other connector names its return-path permissions here so `lint:connector-grants`
 * can prove the dashboard's door is able to grant them. This one genuinely cannot: the
 * permission it needs is whatever the *consumer's* landing operation checks, which
 * differs per vertical and is unknown at this package's build time.
 *
 * That would be an invisible hole — the exact shape of #841, where a connector needed a
 * grant no door could give and the way it surfaced was a failure months later. So the
 * check moves from build time to bind time: {@link bindFortnoxScope} verifies the
 * connection actually holds the named permission in the named scope and **refuses the
 * binding otherwise**, naming what is missing. A sweep can therefore never be configured
 * into a state where it fetches a year of bookkeeping and cannot write it down.
 */
export const FORTNOX_CONNECTION_GRANTS = [] as const;

/** The connector-state key prefix every binding lives under — what the sweep enumerates. */
const BINDING_PREFIX = 'fortnox:binding:';
const bindingKey = (scope: string): string => `${BINDING_PREFIX}${scope}`;

/**
 * What the connector remembers about one scope it syncs into.
 *
 * Directory-side (`putConnectorState`) for the same reason Scrive's ledger is: this is
 * a connector's own bookkeeping, it must survive across sweeps, and it must be readable
 * without entering a scope.
 */
export interface FortnoxBinding {
  scopeId: string;
  tenantId: string;
  /** The scope's vertical — half the key that reopens the connection to poll. */
  vertical: string;
  /**
   * The operation the parsed ledger is landed through, e.g. `'ledger/record-period'`.
   *
   * Named by whoever binds, never defaulted. A default here would be a name this
   * package invented for an operation it does not implement — so the first deployment
   * to get it wrong would find out at sweep time, from an `unknown operation` error
   * three layers down, rather than at bind time from this function.
   */
  operation: string;
  /**
   * The permission `operation` checks, which the connection must hold on `scopeId`.
   *
   * Recorded so the sweep can re-verify cheaply and so an operator can read the whole
   * authority of this binding without opening the vertical's source.
   */
  permission: string;
  /** Absent on pre-kind bindings, which are ledger bindings. */
  kind?: 'ledger' | 'supplier-invoice';
  /**
   * WHICH company's connection reads the books (#2316): the connection's `externalAccountRef`.
   *
   * A bureau holds one Fortnox connection per client company in the same (tenant, vertical)
   * (#1267), so the credential cannot be found from those two alone: opening without the account
   * throws as soon as a second company is connected, which failed every company's sweep. Recorded
   * at bind from the connection being bound. Absent on a binding written before it existed, which
   * still opens the single live connection and fails, naming the re-bind, once there are several.
   */
  externalAccountRef?: string | null;
  boundAt: string;
  /** Set after the first successful sync — the cursor that makes a re-sync cheap. */
  lastSync?: {
    financialYearId: number;
    syncedAt: string;
    /**
     * SHA-256 of the SIE payload AND the window it was read through. Unchanged ⇒ the
     * sync is skipped without landing. The window is in here because what lands is the
     * payload filtered to it, so the same bytes read through a different period are a
     * different result — see the note where this is computed.
     */
    contentHash: string;
    balances: number;
  };
  /** An invoice binding's cursor (#2422), written only after a landing succeeded. */
  invoiceSync?: {
    /** Invoices changed at or after this instant, less {@link INVOICE_OVERLAP_MS}, are read next pass. */
    since: string;
    syncedAt: string;
    /** How many invoices the last landing carried. */
    landed: number;
    /**
     * A change set larger than one pass's budget: when the run began, and the last `GivenNumber`
     * landed. `since` stays put until the run drains, then moves to `startedAt`, so an invoice
     * that changed again mid-run is read again rather than skipped.
     */
    pending?: { startedAt: string; through: string };
  };
}

/**
 * One page of parsed bookkeeping, as it crosses into a scope.
 *
 * Parsed with this schema on the way OUT, before every `invoke`. The engine-seam rule
 * (`returns()`) exists because a value crossing a version boundary must be pinned to a
 * published shape rather than to whatever the code currently produces, and a connector
 * seam is the same boundary with a network in the middle: a vertical compiled against
 * one version of this package and running against another must get a throw, never a
 * silently-reshaped ledger on a screen.
 */
export const fortnoxLedgerPage = z.object({
  /**
   * Identifies this sync RUN, and it is the content hash rather than a ULID on purpose:
   * two syncs of unchanged books produce the same `syncId`, so a consumer's upsert is
   * naturally idempotent and a redelivered page cannot double a balance.
   */
  syncId: z.string().min(1),
  connectionId: z.string().min(1),
  company: z.object({
    name: z.string(),
    organizationNumber: z.string(),
  }),
  financialYear: z.object({
    id: z.number(),
    from: z.string(),
    to: z.string(),
  }),
  page: z.number().int().nonnegative(),
  pageCount: z.number().int().positive(),
  /** True on the last page — the signal a consumer commits or swaps on. */
  final: z.boolean(),
  /** Present on page 0 only; the labels every later page's codes refer to. */
  accounts: z.array(z.object({ number: z.string(), name: z.string() })).default([]),
  costCentres: z.array(z.object({ code: z.string(), name: z.string() })).default([]),
  balances: z.array(
    z.object({
      account: z.string(),
      costCentre: z.string().nullable(),
      month: z.string(),
      /** Debit-positive, as SIE states it. The consumer applies its own sign. */
      amount: money,
    }),
  ),
});
export type FortnoxLedgerPage = z.infer<typeof fortnoxLedgerPage>;

/** How many balance rows ride one `invoke`. */
const PAGE_SIZE = 500;

/**
 * The supplier invoices an invoice binding lands (#2422) — one page per pass that found changes.
 *
 * Parsed on the way OUT, like {@link fortnoxLedgerPage}, and frozen the same way: fields are only
 * ever added. Neutral provider facts; what an invoice means to its reader is the vertical's.
 */
export const fortnoxSupplierInvoicePage = z.object({
  connectionId: z.string().min(1),
  /** The company the invoices belong to — a bureau lands many companies into one install. */
  company: z.object({
    name: z.string(),
    organizationNumber: z.string(),
  }),
  invoices: z
    .array(
      z.object({
        /**
         * Fortnox's own number for the invoice in this company. With `connectionId`, the key a
         * landing upserts by: a later page resends an invoice whenever it changes, and the
         * cursor's overlap can resend one that did not.
         */
        givenNumber: z.string().min(1),
        supplierNumber: z.string(),
        supplierName: z.string(),
        invoiceNumber: z.string(),
        invoiceDate: z.string(),
        dueDate: z.string(),
        /** In the invoice's own currency. */
        total: money,
        booked: z.boolean(),
        cancelled: z.boolean(),
        /** The invoice's accounting rows: debit-positive, in SEK, as the ledger page states them. */
        rows: z.array(
          z.object({
            account: z.string(),
            costCentre: z.string().nullable(),
            amount: money,
          }),
        ),
      }),
    )
    .min(1),
});
export type FortnoxSupplierInvoicePage = z.infer<typeof fortnoxSupplierInvoicePage>;

/**
 * Invoice details read per connection per pass. Fortnox allows 300 calls a minute per client and
 * company, and a ledger connection to the same company spends from that too. A larger change
 * set resumes on the next pass.
 */
const INVOICE_DETAILS_PER_PASS = 200;
/** How far back a binding's first pass reads. */
const INVOICE_FIRST_LOOKBACK_MS = 90 * 86_400_000;
/**
 * Read back from each cursor. Fortnox's filter is to the minute in Swedish local time, and the
 * landing upserts, so re-reading a few minutes costs a resend and missing them costs an invoice.
 */
const INVOICE_OVERLAP_MS = 5 * 60_000;

const STOCKHOLM = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Stockholm',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** An instant as Fortnox's `lastmodified` filter reads it: `YYYY-MM-DD HH:MM`, Swedish local time. */
const stockholmMinute = (ms: number): string => {
  const p = Object.fromEntries(STOCKHOLM.formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
};

export interface FortnoxConnectorOptions {
  fetch: FetchLike;
  apiBase?: string;
  oauthBase?: string;
  timeoutMs?: number;
  /** Injected so a test can assert elapsed time without sleeping. */
  now?: () => number;
}

/**
 * Declare that a connection should sync one scope — the one-time setup a poll-only
 * connector needs in place of a dispatch.
 *
 * **Refuses a binding whose grant is missing**, except for the automatic landing pass
 * after it has validated the declaration and before it writes that grant. The alternative —
 * write the binding, discover at sweep time that the connection cannot invoke the operation —
 * fails in the worst possible place: after a year of bookkeeping has been fetched, in a background timer
 * nobody is watching, with a provider round trip already spent. Here it fails in the
 * operator's hands, naming the permission to grant.
 */
export async function bindFortnoxScope(
  host: ScopeHost,
  input: {
    connectionId: ConnectionId;
    tenantId: string;
    scopeId: string;
    vertical: string;
    operation: string;
    permission: string;
    kind?: 'ledger' | 'supplier-invoice';
    /** Internal automatic-pass path: the declaration was checked and its grant follows this write. */
    grantPreflighted?: boolean;
    /** The connection's `externalAccountRef` — the company. See {@link FortnoxBinding.externalAccountRef}. */
    externalAccountRef?: string | null;
    now?: () => number;
  },
): Promise<FortnoxBinding> {
  const tenant = tenantIdSchema.parse(input.tenantId);
  const scope = scopeIdSchema.parse(input.scopeId);
  const current = (await listFortnoxBindings(host, input.connectionId)).find((b) => b.scopeId === input.scopeId);
  if (current && (current.kind ?? 'ledger') !== (input.kind ?? 'ledger')) {
    throw new Error(`one Fortnox landing kind per scope; use a separate scope for the other kind (${current.kind ?? 'ledger'} to ${input.kind ?? 'ledger'} on scope ${input.scopeId})`);
  }

  // On the host, not `admin`: this is the same projection the permission checker reads,
  // so a binding is verified against the tuples that will actually gate the invoke —
  // not against a directory row that may not have reached the scope yet.
  const granted = input.grantPreflighted ? [] : await host.connectionGrantsInScope(tenant, scope);
  const held = input.grantPreflighted || granted.some(
    (g: { connectionId: string; permission: string }) =>
      g.connectionId === input.connectionId && g.permission === input.permission,
  );
  if (!held) {
    throw new Error(
      `connection ${input.connectionId} does not hold '${input.permission}' on scope ${input.scopeId} — ` +
        `a sweep would fetch the ledger and then fail to land it. Grant it first ` +
        `(grantToConnection), then bind.`,
    );
  }

  const binding: FortnoxBinding = {
    scopeId: input.scopeId,
    tenantId: input.tenantId,
    vertical: input.vertical,
    operation: input.operation,
    permission: input.permission,
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.externalAccountRef ? { externalAccountRef: input.externalAccountRef } : {}),
    boundAt: new Date(input.now?.() ?? Date.now()).toISOString(),
  };
  await host.admin.putConnectorState(input.connectionId, bindingKey(input.scopeId), binding);
  return binding;
}

/** Every scope this connection syncs into. */
export async function listFortnoxBindings(
  host: ScopeHost,
  connectionId: ConnectionId,
): Promise<FortnoxBinding[]> {
  const rows = await host.admin.listConnectorState(connectionId, BINDING_PREFIX);
  // Tombstones filtered, exactly as the sweep and the activity projection do.
  // `unbindFortnoxScope` writes `null` under the same key, and casting that to
  // `FortnoxBinding` hands a caller a typed value that throws on the first property
  // read — a lie the type system cannot catch.
  return rows
    .filter((r) => r.value !== null && typeof r.value === 'object')
    .map((r) => r.value as FortnoxBinding);
}

/**
 * Stop syncing one scope. The binding row is replaced with a tombstone rather than
 * removed, because `putConnectorState` is the only verb this surface has — and an
 * unbound scope that a later sweep silently re-adopts would be worse than a visible
 * dead row.
 */
export async function unbindFortnoxScope(
  host: ScopeHost,
  connectionId: ConnectionId,
  scopeId: string,
): Promise<void> {
  await host.admin.putConnectorState(connectionId, bindingKey(scopeId), null);
}

/** What one scope's sync did. */
export interface FortnoxSyncResult {
  scopeId: string;
  /** False when the books were byte-identical to the last sync — nothing was landed. */
  changed: boolean;
  syncId: string;
  financialYearId: number | null;
  balances: number;
  pages: number;
  /** Transactions dropped for falling outside the requested window. */
  outOfRange: number;
}

const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

/**
 * Sync ONE bound scope: fetch the year that covers `period`, parse it, sum it, and land
 * it through the binding's operation as the connection itself (#97).
 *
 * Idempotent and cheap on a no-op. The SIE payload is hashed before anything is landed,
 * and an unchanged hash returns `changed: false` without a single `invoke` — which
 * matters because a sweep runs on a timer and most passes find books nobody has touched.
 */
export async function syncFortnoxScope(
  host: ScopeHost,
  connectionId: ConnectionId,
  binding: FortnoxBinding,
  options: FortnoxConnectorOptions & { period?: { from: string; to: string } },
): Promise<FortnoxSyncResult> {
  if (binding.kind !== undefined && binding.kind !== 'ledger') {
    throw new Error(`ledger sync cannot use Fortnox binding kind '${String(binding.kind)}'`);
  }
  const admin = host.admin;
  const conn = await openFortnoxConnection(
    admin,
    options.fetch,
    binding.tenantId,
    binding.vertical,
    options.timeoutMs ?? 30_000,
    { externalAccountRef: binding.externalAccountRef ?? null, expected: connectionId },
  );
  const api = new FortnoxApi(conn, {
    apiBase: options.apiBase,
    oauthBase: options.oauthBase,
    now: options.now,
  });

  // The period defaults to the calendar year containing "now", which is the sane
  // default for a recurring sync; a caller back-filling names its own.
  const nowMs = options.now?.() ?? Date.now();
  const year = new Date(nowMs).toISOString().slice(0, 4);
  const period = options.period ?? { from: `${year}-01-01`, to: `${year}-12-31` };

  const years = await api.financialYears();
  // Overlap, never containment — a first financial year can start mid-month. See
  // `financialYearFor`.
  const financialYear = financialYearFor(years, period);
  if (!financialYear) {
    return {
      scopeId: binding.scopeId,
      changed: false,
      syncId: '',
      financialYearId: null,
      balances: 0,
      pages: 0,
      outOfRange: 0,
    };
  }

  const sie = await api.sieFile(financialYear.Id);
  // The WINDOW is part of the sync's identity, not just the payload.
  //
  // What lands is `summarizeLedger(ledger, period)` — the payload filtered to the
  // window — so hashing the payload alone makes two genuinely different results share
  // an identity, and the skip below then drops the second one. A broken financial year
  // is all it takes: with `#RAR` running 2026-07-01..2027-06-30, a December sweep uses
  // the default period 2026-01-01..2026-12-31 and lands only the 2026 months; a January
  // sweep selects the SAME year by overlap, downloads the SAME unchanged payload, and
  // returns `changed: false` — so the 2027 months never land until the books happen to
  // change. Non-calendar financial years are ordinary in Sweden, so this was reachable
  // rather than theoretical. An explicit back-fill over a different window inside an
  // already-synced year was a silent no-op for the same reason.
  //
  // Folding the window in fixes the second half too: `syncId` IS this hash, and it is
  // the consumer's idempotency key. Two windows that land different rows must never
  // present the same key to an upsert.
  const contentHash = await sha256Hex(`${financialYear.Id}\n${period.from}\n${period.to}\n${sie}`);
  if (binding.lastSync?.contentHash === contentHash) {
    return {
      scopeId: binding.scopeId,
      changed: false,
      syncId: contentHash,
      financialYearId: financialYear.Id,
      balances: binding.lastSync.balances,
      pages: 0,
      outOfRange: 0,
    };
  }

  const ledger = parseSie4(sie);
  const summary = summarizeLedger(ledger, period);

  // The connection acting as itself (#97). Refuses a scope in another tenant or running
  // another vertical by construction, and the invoke below is gated on the connection's
  // own grant — the one `bindFortnoxScope` verified.
  const scope = await host.getConnectorScope(connectionId, scopeIdSchema.parse(binding.scopeId));

  const pageCount = Math.max(1, Math.ceil(summary.balances.length / PAGE_SIZE));
  for (let page = 0; page < pageCount; page += 1) {
    const slice = summary.balances.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const payload = fortnoxLedgerPage.parse({
      syncId: contentHash,
      connectionId,
      company: { name: ledger.company, organizationNumber: ledger.organizationNumber },
      financialYear: {
        id: financialYear.Id,
        from: financialYear.FromDate,
        to: financialYear.ToDate,
      },
      page,
      pageCount,
      final: page === pageCount - 1,
      // The labels ride page 0 only: they are the same on every page, and repeating a
      // full chart of accounts across twenty pages is bytes through a clone pipe for
      // nothing.
      accounts: page === 0 ? summary.accounts : [],
      costCentres: page === 0 ? summary.costCentres : [],
      balances: slice,
    });
    await scope.invoke(binding.operation, payload);
  }

  const synced: FortnoxBinding = {
    ...binding,
    lastSync: {
      financialYearId: financialYear.Id,
      syncedAt: new Date(nowMs).toISOString(),
      contentHash,
      balances: summary.balances.length,
    },
  };
  // Written only AFTER every page landed, so a failure mid-way leaves the cursor at the
  // previous hash and the next sweep retries the whole year rather than resuming into a
  // half-written ledger.
  await admin.putConnectorState(connectionId, bindingKey(binding.scopeId), synced);

  return {
    scopeId: binding.scopeId,
    changed: true,
    syncId: contentHash,
    financialYearId: financialYear.Id,
    balances: summary.balances.length,
    pages: pageCount,
    outOfRange: summary.outOfRange,
  };
}

/** What one invoice binding's pass did. */
export interface FortnoxInvoiceSyncResult {
  scopeId: string;
  /** Invoices landed this pass; 0 when nothing changed or the pass's budget was spent. */
  landed: number;
  /** True when changed invoices are left for a later pass. */
  pending: boolean;
}

/**
 * Sync ONE invoice binding (#2422): list the supplier invoices changed since its cursor, read
 * each one's rows, and land them in one page through the binding's operation as the connection.
 *
 * Read-only toward Fortnox. Reads at most `budget.details` invoices, oldest number first, and
 * spends from the budget so bindings sharing a pass share Fortnox's rate limit. The cursor is
 * written only after the landing succeeded, so a refused page is read again next pass.
 */
export async function syncFortnoxSupplierInvoices(
  host: ScopeHost,
  connectionId: ConnectionId,
  binding: FortnoxBinding,
  options: FortnoxConnectorOptions & { budget?: { details: number } },
): Promise<FortnoxInvoiceSyncResult> {
  if (binding.kind !== 'supplier-invoice') {
    throw new Error(`supplier-invoice sync cannot use Fortnox binding kind '${String(binding.kind ?? 'ledger')}'`);
  }
  const conn = await openFortnoxConnection(
    host.admin,
    options.fetch,
    binding.tenantId,
    binding.vertical,
    options.timeoutMs ?? 30_000,
    { externalAccountRef: binding.externalAccountRef ?? null, expected: connectionId },
  );
  const api = new FortnoxApi(conn, { apiBase: options.apiBase, oauthBase: options.oauthBase, now: options.now });

  const nowMs = options.now?.() ?? Date.now();
  const cursor = binding.invoiceSync;
  const since = cursor ? Date.parse(cursor.since) : nowMs - INVOICE_FIRST_LOOKBACK_MS;
  const through = cursor?.pending ? Number(cursor.pending.through) : -Infinity;
  const changed = [...new Set(await api.supplierInvoicesModifiedSince(stockholmMinute(since - INVOICE_OVERLAP_MS)))]
    .filter((n) => Number(n) > through)
    .sort((a, b) => Number(a) - Number(b));
  const budget = options.budget ?? { details: INVOICE_DETAILS_PER_PASS };
  const batch = changed.slice(0, budget.details);
  if (batch.length === 0) return { scopeId: binding.scopeId, landed: 0, pending: changed.length > 0 };
  budget.details -= batch.length;

  const invoices = [];
  for (const givenNumber of batch) {
    const invoice = await api.supplierInvoice(givenNumber);
    invoices.push({
      givenNumber: invoice.GivenNumber,
      supplierNumber: invoice.SupplierNumber,
      supplierName: invoice.SupplierName,
      invoiceNumber: invoice.InvoiceNumber,
      invoiceDate: invoice.InvoiceDate,
      dueDate: invoice.DueDate,
      total: { amount: invoice.Total, currency: invoice.Currency },
      booked: invoice.Booked,
      cancelled: invoice.Cancelled,
      rows: invoice.SupplierInvoiceRows.map((row) => ({
        account: row.Account,
        costCentre: row.CostCenter || null,
        amount: { amount: addDecimal(row.Debit, mulDecimal('-1', row.Credit)), currency: 'SEK' },
      })),
    });
  }
  const company = await api.companyInformation();
  const payload = fortnoxSupplierInvoicePage.parse({
    connectionId,
    company: { name: company.CompanyName, organizationNumber: company.OrganizationNumber },
    invoices,
  });
  // The connection acting as itself (#97), gated on the grant the binding was seated with.
  const scope = await host.getConnectorScope(connectionId, scopeIdSchema.parse(binding.scopeId));
  await scope.invoke(binding.operation, payload);

  const more = changed.length > batch.length;
  const startedAt = cursor?.pending?.startedAt ?? new Date(nowMs).toISOString();
  const synced: FortnoxBinding = {
    ...binding,
    invoiceSync: {
      since: more ? new Date(since).toISOString() : startedAt,
      syncedAt: new Date(nowMs).toISOString(),
      landed: batch.length,
      ...(more ? { pending: { startedAt, through: batch[batch.length - 1]! } } : {}),
    },
  };
  await host.admin.putConnectorState(connectionId, bindingKey(binding.scopeId), synced);
  return { scopeId: binding.scopeId, landed: batch.length, pending: more };
}

/** What one sweep pass over a connection did. */
export interface FortnoxSweepResult {
  found: number;
  /** Ledger bindings whose books changed and landed. */
  synced: FortnoxSyncResult[];
  /** Invoice bindings that landed invoices. */
  invoices: FortnoxInvoiceSyncResult[];
  unchanged: number;
  failed: { scopeId: string; error: string }[];
}

/**
 * Poll Fortnox for every scope this connection is bound to — the {@link ConnectorSweeper}
 * a deployment schedules. A ledger binding syncs its year of books
 * ({@link syncFortnoxScope}); an invoice binding lands the supplier invoices changed since its
 * cursor ({@link syncFortnoxSupplierInvoices}). The name predates invoices and is kept.
 *
 * A timer calls this; it holds no timer itself. That keeps the trigger a deployment
 * concern (`startPlatformSweeper` on node, `definePlatformSweeperDO`'s alarm on
 * Cloudflare) and this a plain, testable function.
 *
 * Robust the way a poller must be: an unchanged year is skipped without landing
 * anything, and a failure on one scope is recorded and stepped over rather than sinking
 * the pass — one vertical's missing grant must not stop another tenant's books syncing.
 */
export async function sweepFortnoxLedger(
  host: ScopeHost,
  connectionId: ConnectionId,
  options: FortnoxConnectorOptions & { period?: { from: string; to: string } },
): Promise<FortnoxSweepResult> {
  const rows = await host.admin.listConnectorState(connectionId, BINDING_PREFIX);
  const result: FortnoxSweepResult = { found: 0, synced: [], invoices: [], unchanged: 0, failed: [] };
  // One budget per pass: invoice bindings on this connection read the same company.
  const budget = { details: INVOICE_DETAILS_PER_PASS };

  for (const { value } of rows) {
    // A tombstoned binding (`unbindFortnoxScope`) — present as a row, not a target.
    if (value === null || typeof value !== 'object') continue;
    const binding = value as FortnoxBinding;
    result.found += 1;
    if (binding.kind !== undefined && binding.kind !== 'ledger' && binding.kind !== 'supplier-invoice') {
      result.failed.push({ scopeId: binding.scopeId, error: `unknown Fortnox binding kind '${String(binding.kind)}'; upgrade this platform before polling this binding` });
      continue;
    }
    try {
      if (binding.kind === 'supplier-invoice') {
        const r = await syncFortnoxSupplierInvoices(host, connectionId, binding, { ...options, budget });
        if (r.landed > 0) result.invoices.push(r);
        else result.unchanged += 1;
        continue;
      }
      const r = await syncFortnoxScope(host, connectionId, binding, options);
      if (r.changed) result.synced.push(r);
      else result.unchanged += 1;
    } catch (err) {
      result.failed.push({
        scopeId: binding.scopeId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

/**
 * Probe a credential that is not stored yet — the connect-time check (#605).
 *
 * Takes the candidate secret directly, touches no connection and no store, and records
 * no health: there may be no connection to record against, and a candidate's failure is
 * not a fact about a live one.
 *
 * The probe is a token mint followed by `companyinformation`, and it must be both:
 * minting alone proves the client pair and the consent, but only the company read proves
 * the `TenantId` names a company this integration can actually see — which is the field
 * an operator is most likely to paste wrong.
 */
export async function probeFortnoxSecret(
  secret: Record<string, string>,
  options: FortnoxConnectorOptions,
): Promise<ConnectionProbe> {
  const parsed = fortnoxSecret.safeParse(secret);
  if (!parsed.success) {
    // A malformed credential IS a refusal — Fortnox would reject it, and there is no
    // point spending a round trip to hear so.
    return {
      ok: false,
      refused: true,
      accountRef: null,
      accountLabel: null,
      facts: [],
      error: `incomplete Fortnox credential: ${parsed.error.issues
        .map((i) => i.path.join('.'))
        .join(', ')}`,
    };
  }
  const timeoutMs = options.timeoutMs ?? 15_000;
  const conn: ConnectorConnection = {
    id: connectionIdSchema.parse('00000000000000000000000000'), // no row yet; never read
    tenantId: '',
    vertical: '',
    provider: 'fortnox',
    secret: parsed.data,
    // Probe stub, not where expiry is set. Fortnox mints 1h access tokens via client_credentials and has NO refresh token (api.ts); recording the access token expiry here would warn on every row. See connections.md §3.6.
    expiresAt: null,
    fetch: deadlineFetch(options.fetch, timeoutMs),
  };
  return probeWith(conn, options);
}

/** Probe the credential a live connection already holds. Verifying is itself a use. */
export async function probeFortnoxConnection(
  host: ScopeHost,
  connection: { tenantId: string; vertical: string; externalAccountRef?: string | null },
  options: FortnoxConnectorOptions,
): Promise<ConnectionProbe> {
  const conn = await openFortnoxConnection(
    host.admin,
    options.fetch,
    connection.tenantId,
    connection.vertical,
    options.timeoutMs ?? 15_000,
    { externalAccountRef: connection.externalAccountRef ?? null },
  );
  return probeWith(conn, options);
}

async function probeWith(
  conn: ConnectorConnection,
  options: FortnoxConnectorOptions,
): Promise<ConnectionProbe> {
  const api = new FortnoxApi(conn, {
    apiBase: options.apiBase,
    oauthBase: options.oauthBase,
    now: options.now,
  });
  try {
    const company = await api.companyInformation();
    const years = await api.financialYears();
    const ref = company.DatabaseNumber === undefined ? null : String(company.DatabaseNumber);
    return {
      ok: true,
      refused: false,
      accountRef: ref,
      accountLabel: company.CompanyName || null,
      facts: [
        { label: 'Organisationsnummer', value: company.OrganizationNumber || '—' },
        { label: 'Database number', value: ref ?? '—' },
        {
          label: 'Financial years',
          value:
            years.length === 0
              ? 'none'
              : `${years.length} (${years
                  .map((y) => y.FromDate.slice(0, 4))
                  .sort()
                  .join(', ')})`,
        },
      ],
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      // Only "not with these credentials" counts. A timeout or a 5xx says nothing about
      // the credential, and treating it as a refusal would make a Fortnox outage look
      // like every tenant's keys going bad at once.
      refused: err instanceof FortnoxApiError && err.refused,
      accountRef: null,
      accountLabel: null,
      facts: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * What this connection has been doing, for a console — one entry per bound scope.
 *
 * Reads the binding ledger rather than the provider: this answers "what has the platform
 * synced", which is the question an operator asks when a figure looks stale, and it
 * answers it without spending a provider round trip.
 */
export async function fortnoxConnectionActivity(
  host: ScopeHost,
  connectionId: ConnectionId,
): Promise<ConnectionActivity> {
  const rows = await host.admin.listConnectorState(connectionId, BINDING_PREFIX);
  const entries = rows
    .filter(({ value }) => value !== null && typeof value === 'object')
    .map(({ key, value }) => {
      const b = value as FortnoxBinding;
      return {
        key,
        title: `${b.vertical} — ${b.scopeId}`,
        reference: b.lastSync ? String(b.lastSync.financialYearId) : null,
        status: b.lastSync || b.invoiceSync ? 'synced' : 'bound — not yet synced',
        at: instant.parse(b.lastSync?.syncedAt ?? b.invoiceSync?.syncedAt ?? b.boundAt),
        facts: [
          { label: 'Lands through', value: b.operation },
          { label: 'Permission', value: b.permission },
          ...(b.lastSync
            ? [
                { label: 'Balances', value: String(b.lastSync.balances) },
                { label: 'Financial year', value: String(b.lastSync.financialYearId) },
                // The content hash IS the sync identity, so an operator comparing two
                // scopes can tell "same books" from "same moment" at a glance.
                { label: 'Content hash', value: b.lastSync.contentHash.slice(0, 12) },
              ]
            : []),
        ],
      };
    });
  return connectionActivity.parse({
    source: 'ledger',
    entries,
    // Never live: this reads the binding ledger, never the provider. The ledger knows
    // what the platform synced, not what Fortnox has since booked, and a console that
    // blurs the two invents facts.
    live: false,
  });
}

/**
 * The stored credential, REDUCED (#605) — identifiers whole, secrets masked.
 *
 * `tenantId` is deliberately unmasked: it is the company's DatabaseNumber — an
 * identifier, not a secret — and it is the field an operator most needs to read when a
 * connection syncs the wrong company's books.
 */
export async function fortnoxCredentialSummary(
  host: ScopeHost,
  connection: { tenantId: string; vertical: string; externalAccountRef?: string | null },
): Promise<ConnectionCredential> {
  // #2316: this company's connection, not whichever one (tenant, vertical) would pick.
  const open = await host.admin.openConnection(
    tenantIdSchema.parse(connection.tenantId),
    connection.vertical,
    'fortnox',
    connection.externalAccountRef ?? undefined,
  );
  if (!open) {
    throw new Error(
      `no live 'fortnox' connection for tenant ${connection.tenantId} / vertical '${connection.vertical}'`,
    );
  }
  const secret = fortnoxSecret.parse(open.secret);
  return {
    fields: [
      { key: 'clientId', label: 'Client ID', value: secret.clientId, masked: false },
      { key: 'clientSecret', label: 'Client secret', value: maskSecret(secret.clientSecret), masked: true },
      { key: 'tenantId', label: 'Tenant ID (DatabaseNumber)', value: secret.tenantId, masked: false },
    ],
  };
}

/** A bullet run plus the last four — or nothing at all when there is too little to hide behind. */
const maskSecret = (value: string): string =>
  value.length < 8 ? '••••••••' : `••••••••${value.slice(-4)}`;

/**
 * Open the live Fortnox connection for a (tenant, vertical) — and, with several companies
 * connected, the one `account.externalAccountRef` names (#2316) — with health recorded.
 *
 * `account.expected` is the connection a binding names. The credential that reads and the
 * identity that writes must be the same connection, so a mismatch is refused loudly rather than
 * landing one company's books as another's connection — Planima's backstop, which here guards a
 * reachable case: a binding written before it recorded the account, once a second company exists.
 */
async function openFortnoxConnection(
  admin: HostAdmin,
  fetchImpl: FetchLike,
  tenant: string,
  vertical: string,
  timeoutMs: number,
  account: { externalAccountRef?: string | null; expected?: ConnectionId } = {},
): Promise<ConnectorConnection> {
  const parsedTenant = tenantIdSchema.parse(tenant);
  const open = await admin.openConnection(parsedTenant, vertical, 'fortnox', account.externalAccountRef ?? undefined);
  if (!open) {
    throw new Error(
      `no live 'fortnox' connection for tenant ${tenant} / vertical '${vertical}'` +
        (account.externalAccountRef ? ` and company ${account.externalAccountRef}` : ''),
    );
  }
  if (account.expected !== undefined && open.id !== account.expected) {
    throw new Error(
      `binding names connection ${account.expected}, but the live 'fortnox' connection opened for tenant ` +
        `${tenant} / vertical '${vertical}' is ${open.id} — the credential that reads and the identity ` +
        `that writes must be the same connection. Re-bind the scope against ${account.expected}.`,
    );
  }
  const bounded = deadlineFetch(fetchImpl, timeoutMs);
  return {
    ...open,
    fetch: async (input, init) => {
      // #1691: timed, so the host's per-call data point carries a duration.
      const started = Date.now();
      try {
        const res = await bounded(input, init);
        await admin.recordConnectionUse(
          open.id,
          settleConnectionUse('fortnox', Date.now() - started, { response: res }),
        );
        return res;
      } catch (err) {
        await admin.recordConnectionUse(
          open.id,
          settleConnectionUse('fortnox', Date.now() - started, { error: err }),
        );
        throw err;
      }
    },
  };
}
