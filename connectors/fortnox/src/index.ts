import { z } from 'zod';
import {
  addDecimal,
  CONNECTOR_ATTACHMENT_BUFFERED_MAX_BYTES,
  connectionActivity,
  connectionId as connectionIdSchema,
  entityRef,
  instant,
  money,
  mulDecimal,
  scopeId as scopeIdSchema,
  tenantId as tenantIdSchema,
  type ConnectionActivity,
  type ConnectionCredential,
  type ConnectionProbe,
  type ConnectionId,
  type ScopeId,
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
  type FortnoxApiOptions,
  type FortnoxFinancialYear,
  type FortnoxSupplierInvoice,
  type FortnoxSupplierInvoiceFile,
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
  type FortnoxApiOptions,
  type FortnoxSupplierInvoice,
  type FortnoxSupplierInvoiceFile,
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
   * What a ledger binding lands. Absent is `'summary'`: the monthly sums of {@link fortnoxLedgerPage}.
   * `'sie'` is the year's whole SIE4 file, {@link fortnoxSieFile}, for a vertical that keeps what the
   * sums leave out: opening and closing balances, and the vouchers themselves.
   */
  form?: FortnoxLedgerForm;
  /**
   * How many financial years before the current one a `form: 'sie'` binding keeps, or `'all'`.
   * Absent is none: the current year alone, as a summary binding has.
   */
  years?: FortnoxLedgerYears;
  /**
   * How far back an invoice binding's first pass reads: a number of days, or `'all'` for every
   * invoice the company has. Absent means {@link INVOICE_FIRST_LOOKBACK_DAYS}.
   */
  firstPass?: FortnoxInvoiceFirstPass;
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
  /**
   * What a `form: 'sie'` binding has landed, per financial year id. `syncedAt` moves when the year
   * was last read, changed or not, which is how an older year knows it is due.
   */
  yearSync?: Record<string, { syncedAt: string; contentHash: string }>;
  /** An invoice binding's cursor (#2422), written only after a landing succeeded. */
  invoiceSync?: {
    /**
     * Invoices changed at or after this instant, less {@link INVOICE_OVERLAP_MS}, are read next
     * pass. `null` while a `firstPass: 'all'` run drains: the list then has no filter.
     */
    since: string | null;
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
  /**
   * An invoice binding's files still to be read, oldest first. Held because an invoice that does
   * not change is never landed again, so nothing else would ask for its file a second time.
   * Bounded: a pass reads what is queued before it lands more. Beside the cursor rather than in it,
   * so a re-bind, which starts the cursor over, keeps what was asked.
   */
  files?: FortnoxInvoiceFileEntry[];
}

/** What a ledger binding lands. See {@link FortnoxBinding.form}. */
export type FortnoxLedgerForm = 'summary' | 'sie';
/** How many older years a `form: 'sie'` binding keeps. See {@link FortnoxBinding.years}. */
export type FortnoxLedgerYears = 'all' | number;

/** How far back an invoice binding's first pass reads. See {@link FortnoxBinding.firstPass}. */
export type FortnoxInvoiceFirstPass = 'all' | number;

/** One invoice whose file the landing asked for. */
export interface FortnoxInvoiceFileEntry {
  givenNumber: string;
  /** The entity the file lands on, as the landing named it. */
  entity: { entityType: string; entityId: string };
}

/**
 * The files of one invoice already landed on an entity, one row per invoice, so an invoice asked
 * about again (it changed, the binding was re-bound) lands only what is new. A row naming another
 * entity counts for nothing: the landing moved the invoice, and its files follow it.
 */
interface FortnoxInvoiceFilesLanded {
  entity: { entityType: string; entityId: string };
  fileIds: string[];
}
const FILES_LANDED_PREFIX = 'fortnox:files-landed:';
const filesLandedKey = (scope: string, givenNumber: string): string => `${FILES_LANDED_PREFIX}${scope}:${givenNumber}`;

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
 * One financial year's whole SIE4 file, as a `form: 'sie'` binding lands it, in one `invoke`.
 *
 * The file itself, because it already is the neutral statement of the books, and everything a
 * reader could want is in it: the opening and closing balances the sums skip, every voucher, every
 * account name. A vertical that takes uploaded SIE files has a reader for it already, and this way
 * a file from Fortnox and a file from a person go through the same door.
 *
 * Decoded from PC8, so `sie` is text. Parsed on the way out like {@link fortnoxLedgerPage}.
 */
export const fortnoxSieFile = z.object({
  /** The content hash: unchanged books present the same id, so a landing can answer it once. */
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
  sie: z.string().min(1),
});
export type FortnoxSieFile = z.infer<typeof fortnoxSieFile>;

/** How long a `form: 'sie'` binding leaves an older year before reading it again. */
const OLDER_YEAR_REFRESH_MS = 24 * 3_600_000;

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
        /** What is left to pay, in the invoice's currency. Absent when Fortnox states none. */
        balance: money.optional(),
        /** In the invoice's currency. Absent when Fortnox states none. */
        vat: money.optional(),
        ocr: z.string().nullable().optional(),
        booked: z.boolean(),
        cancelled: z.boolean(),
        /** A credit note. */
        credit: z.boolean().optional(),
        /** A payment of the invoice is on its way. */
        paymentPending: z.boolean().optional(),
        /** The old single comment, while an invoice still has one. New comments are in `commentLog`. */
        comments: z.string().nullable().optional(),
        /** Fortnox's comment log, oldest first as Fortnox lists it. Its web UI writes only here. */
        commentLog: z
          .array(z.object({ comment: z.string(), createdAt: z.string().nullable(), userName: z.string().nullable() }))
          .optional(),
        /** The voucher the invoice was booked on. `year` is Fortnox's number for the financial year. */
        voucher: z.object({ series: z.string().nullable(), number: z.number().int(), year: z.number().int().nullable() }).nullable().optional(),
        project: z.string().nullable().optional(),
        costCentre: z.string().nullable().optional(),
        /** The invoice's accounting rows: debit-positive, in SEK, as the ledger page states them. */
        rows: z.array(
          z.object({
            account: z.string(),
            /** The account's name, as Fortnox writes it on the row. */
            accountDescription: z.string().nullable().optional(),
            costCentre: z.string().nullable(),
            project: z.string().nullable().optional(),
            transactionInformation: z.string().nullable().optional(),
            amount: money,
          }),
        ),
      }),
    )
    .min(1),
});
export type FortnoxSupplierInvoicePage = z.infer<typeof fortnoxSupplierInvoicePage>;

/**
 * What a landing operation may answer. `files` names the invoices whose file the vertical wants
 * and the entity each one lands on, which must be a declared attachment target the connection
 * can write. An answer without it, or that does not parse, asks for no file.
 */
export const fortnoxSupplierInvoiceLandingAnswer = z
  .object({ files: z.array(z.object({ givenNumber: z.string().min(1), entity: entityRef })).optional() })
  .passthrough();
export type FortnoxSupplierInvoiceLandingAnswer = z.infer<typeof fortnoxSupplierInvoiceLandingAnswer>;

/**
 * Invoice details read per connection per pass. The client paces every read to Fortnox's limit,
 * so this bounds how long one pass runs (about 40 seconds at the limit) rather than the rate. A
 * larger change set resumes on the next pass.
 */
const INVOICE_DETAILS_PER_PASS = 200;
/**
 * How long one binding's pass keeps starting invoice reads. Pacing alone puts 200 reads at about
 * 40 seconds, but every 429 adds its wait, and a sweep holds one of a few concurrent slots while
 * it runs. Past this, what was read lands and the next pass resumes after it.
 */
const INVOICE_PASS_DEADLINE_MS = 90_000;
/** How far back a binding's first pass reads when its declaration does not say. */
export const INVOICE_FIRST_LOOKBACK_DAYS = 90;
/** What one queued invoice costs from a pass's budget at the least: its connections, one file. */
const INVOICE_FILE_READS = 2;
/** The largest file a pass will hold. A larger one is skipped by name, never truncated. */
const INVOICE_FILE_MAX_BYTES = CONNECTOR_ATTACHMENT_BUFFERED_MAX_BYTES;
/** A file's type by its name, for an archive read that does not say or says only "bytes". */
const FILE_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
};
const fileType = (name: string, stated: string | null): string => {
  const type = stated?.split(';')[0]?.trim().toLowerCase();
  if (type && type !== 'application/octet-stream') return type;
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return Object.hasOwn(FILE_TYPES, ext) ? FILE_TYPES[ext]! : 'application/octet-stream';
};
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

/** An instant as Swedish wall time to the minute: `YYYY-MM-DD HH:MM`. */
const stockholmMinute = (ms: number): string => {
  const p = Object.fromEntries(STOCKHOLM.formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
};

/**
 * The `lastmodified` filter for a cursor. Fortnox filters by wall time, and the autumn change
 * repeats an hour: a cursor in the FIRST 02:xx would hide a change made in the second 02:xx at
 * an earlier minute. So inside the first pass of a repeated hour, the filter starts at that
 * hour's beginning; the landing upserts, so the extra minutes cost only resends.
 */
const lastModifiedFilter = (ms: number): string => {
  const wall = stockholmMinute(ms);
  return stockholmMinute(ms + 3_600_000) === wall ? `${wall.slice(0, 14)}00` : wall;
};

export interface FortnoxConnectorOptions {
  fetch: FetchLike;
  apiBase?: string;
  oauthBase?: string;
  timeoutMs?: number;
  /** Injected so a test can assert elapsed time without sleeping. */
  now?: () => number;
  /** Injected for the same reason: the rate-limit waits go through this. */
  sleep?: (ms: number) => Promise<void>;
  /** One window for every client of a pass; see {@link FortnoxApiOptions.rateWindow}. */
  rateWindow?: number[];
}

/** The client options a sync builds its `FortnoxApi` with. */
const apiOptions = (options: FortnoxConnectorOptions): FortnoxApiOptions => ({
  apiBase: options.apiBase,
  oauthBase: options.oauthBase,
  now: options.now,
  sleep: options.sleep,
  rateWindow: options.rateWindow,
});

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
    /** What a ledger binding lands. See {@link FortnoxBinding.form}. */
    form?: FortnoxLedgerForm;
    /** How many older years it keeps. See {@link FortnoxBinding.years}. */
    years?: FortnoxLedgerYears;
    /** An invoice binding's first pass. See {@link FortnoxBinding.firstPass}. */
    firstPass?: FortnoxInvoiceFirstPass;
    /** Internal automatic-pass path: the declaration was checked and its grant follows this write. */
    grantPreflighted?: boolean;
    /** The connection's `externalAccountRef` — the company. See {@link FortnoxBinding.externalAccountRef}. */
    externalAccountRef?: string | null;
    now?: () => number;
  },
): Promise<FortnoxBinding> {
  const tenant = tenantIdSchema.parse(input.tenantId);
  const scope = scopeIdSchema.parse(input.scopeId);
  if (input.form !== undefined && (input.kind ?? 'ledger') !== 'ledger') {
    throw new Error(`form applies to a ledger binding, not to '${String(input.kind)}'`);
  }
  if (input.years !== undefined && input.form !== 'sie') {
    throw new Error("years applies to a binding with form 'sie': the summary form lands the current year");
  }
  if (input.years !== undefined && input.years !== 'all' && !(Number.isInteger(input.years) && input.years >= 0)) {
    throw new Error(`years is 'all' or a whole number of years, not ${String(input.years)}`);
  }
  if (input.firstPass !== undefined && input.kind !== 'supplier-invoice') {
    throw new Error(`firstPass applies to a supplier-invoice binding, not to '${input.kind ?? 'ledger'}'`);
  }
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
    ...(input.form !== undefined ? { form: input.form } : {}),
    ...(input.years !== undefined ? { years: input.years } : {}),
    ...(input.firstPass !== undefined ? { firstPass: input.firstPass } : {}),
    ...(input.externalAccountRef ? { externalAccountRef: input.externalAccountRef } : {}),
    // A re-bind that changes nothing keeps the years already landed: an operator re-PUT or a scope
    // asking again must not re-download a whole history. Any change starts over, a newly recorded
    // company included, since the years held may be another company's.
    ...(current?.yearSync && input.form === 'sie' && current.form === 'sie' && current.years === input.years &&
      current.operation === input.operation && (current.externalAccountRef ?? null) === (input.externalAccountRef ?? null)
      ? { yearSync: current.yearSync }
      : {}),
    // A re-bind starts the cursor over but keeps the files already asked for: an invoice outside a
    // narrowed first pass would otherwise never be asked about again.
    ...(current?.files?.length ? { files: current.files } : {}),
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
  const api = new FortnoxApi(conn, apiOptions(options));

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

/**
 * Sync ONE `form: 'sie'` binding: land the current year's SIE4 file if it changed, and bring one
 * older year up to date.
 *
 * One older year per pass, because a year is one large download and a pass runs on a timer. A
 * company's history therefore lands newest year first, a year a quarter of an hour, and after that
 * each older year is read once a day: a closed year rarely moves, but nothing stops it moving. A
 * year whose file has not changed lands nothing.
 *
 * Each year is written to the binding right after it lands, so a failure on one costs only that one,
 * and the years that did land are answered beside the ones that failed.
 */
export async function syncFortnoxSieFiles(
  host: ScopeHost,
  connectionId: ConnectionId,
  binding: FortnoxBinding,
  options: FortnoxConnectorOptions & { period?: { from: string; to: string } },
): Promise<{ synced: FortnoxSyncResult[]; failed: { financialYearId: number; error: unknown }[] }> {
  const conn = await openFortnoxConnection(
    host.admin,
    options.fetch,
    binding.tenantId,
    binding.vertical,
    options.timeoutMs ?? 30_000,
    { externalAccountRef: binding.externalAccountRef ?? null, expected: connectionId },
  );
  const api = new FortnoxApi(conn, apiOptions(options));

  const nowMs = options.now?.() ?? Date.now();
  const year = new Date(nowMs).toISOString().slice(0, 4);
  const years = await api.financialYears();
  const current = financialYearFor(years, options.period ?? { from: `${year}-01-01`, to: `${year}-12-31` });
  if (!current) return { synced: [], failed: [] };

  const held = (y: FortnoxFinancialYear) => binding.yearSync?.[String(y.Id)];
  const kept = binding.years === 'all' ? Infinity : (binding.years ?? 0);
  // Never read comes first, newest first (the sort is stable), because the recent years are the
  // ones a reader wants. After that, the one read longest ago.
  const due = years
    .filter((y) => y.FromDate < current.FromDate)
    .sort((a, b) => (a.FromDate < b.FromDate ? 1 : -1))
    .slice(0, kept)
    .filter((y) => {
      const last = held(y)?.syncedAt;
      return last === undefined || nowMs - Date.parse(last) >= OLDER_YEAR_REFRESH_MS;
    })
    .sort((a, b) => (held(a)?.syncedAt ?? '').localeCompare(held(b)?.syncedAt ?? ''));

  const key = bindingKey(binding.scopeId);
  const synced: FortnoxSyncResult[] = [];
  const failed: { financialYearId: number; error: unknown }[] = [];
  for (const financialYear of [current, ...due.slice(0, 1)]) {
    try {
      const sie = await api.sieFile(financialYear.Id);
      const contentHash = await sha256Hex(`sie\n${financialYear.Id}\n${sie}`);
      const changed = held(financialYear)?.contentHash !== contentHash;
      if (changed) {
        // The file names its company (#FNAMN, #ORGNR), as the summary form reads it.
        const ledger = parseSie4(sie);
        // The connection acting as itself (#97), gated on the grant the binding was seated with.
        const scope = await host.getConnectorScope(connectionId, scopeIdSchema.parse(binding.scopeId));
        await scope.invoke(
          binding.operation,
          fortnoxSieFile.parse({
            syncId: contentHash,
            connectionId,
            company: { name: ledger.company, organizationNumber: ledger.organizationNumber },
            financialYear: { id: financialYear.Id, from: financialYear.FromDate, to: financialYear.ToDate },
            sie,
          }),
        );
      }
      // A year is a long download, so the binding read at the start of the pass may be stale by now:
      // the cursor goes onto the binding as it stands, and one unbound or re-bound meanwhile is left
      // as the person left it rather than brought back from this pass's copy.
      const now = (await host.admin.getConnectorState(connectionId, key)) as FortnoxBinding | null | undefined;
      if (!now || typeof now !== 'object' || now.boundAt !== binding.boundAt) break;
      const syncedAt = new Date(nowMs).toISOString();
      await host.admin.putConnectorState(connectionId, key, {
        ...now,
        yearSync: { ...now.yearSync, [String(financialYear.Id)]: { syncedAt, contentHash } },
        ...(financialYear === current ? { lastSync: { financialYearId: current.Id, syncedAt, contentHash, balances: 0 } } : {}),
      } satisfies FortnoxBinding);
      synced.push({
        scopeId: binding.scopeId,
        changed,
        syncId: contentHash,
        financialYearId: financialYear.Id,
        balances: 0,
        pages: changed ? 1 : 0,
        outOfRange: 0,
      });
    } catch (error) {
      failed.push({ financialYearId: financialYear.Id, error });
    }
  }
  return { synced, failed };
}

/** What one invoice binding's pass did. */
export interface FortnoxInvoiceSyncResult {
  scopeId: string;
  /** Invoices landed this pass; 0 when nothing changed or the pass's budget was spent. */
  landed: number;
  /** Invoice files landed this pass. */
  files: number;
  /** Files stepped over, and why. Their invoice is asked about again when it next lands. */
  skipped?: { givenNumber: string; reason: string }[];
  /** True when changed invoices or queued files are left for a later pass. */
  pending: boolean;
}

/**
 * Sync ONE invoice binding (#2422): read the files earlier passes left, list the supplier invoices
 * changed since its cursor, read each one's rows, land them in one page through the binding's
 * operation as the connection, then read the files the landing asked for.
 *
 * Read-only toward Fortnox. Reads at most `budget.details` times for invoices and files, oldest
 * number first, and spends from the budget so bindings sharing a pass share Fortnox's rate limit.
 * The cursor is written only after the landing succeeded, so a refused page is read again next pass.
 *
 * Files come after the cursor, because a file that cannot be read says nothing about the invoice:
 * the invoices keep landing, and the file stays queued and fails the scope's row by its number.
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
  const api = new FortnoxApi(conn, apiOptions(options));

  const nowMs = options.now?.() ?? Date.now();
  const expired = () => (options.now?.() ?? Date.now()) - nowMs >= INVOICE_PASS_DEADLINE_MS;
  const cursor = binding.invoiceSync;
  const budget = options.budget ?? { details: INVOICE_DETAILS_PER_PASS };
  const scopeRef = scopeIdSchema.parse(binding.scopeId);

  const files = new InvoiceFiles(host, connectionId, binding.scopeId, scopeRef, api, budget, expired, binding.files);
  const withFiles = (base: FortnoxBinding): FortnoxBinding => {
    const { files: _held, ...rest } = base;
    return { ...rest, ...files.held() };
  };
  const saveFiles = async (base: FortnoxBinding): Promise<void> => {
    if (!files.moved) return;
    await host.admin.putConnectorState(connectionId, bindingKey(binding.scopeId), withFiles(base));
    files.moved = false;
  };
  // The queue goes first, so it never outgrows one pass's budget, and it is saved at once, so a
  // landing that throws below does not cost what was read. Its failures wait for the end.
  await files.drain();
  await saveFiles(binding);

  const finish = (landed: number, pending: boolean): FortnoxInvoiceSyncResult => ({
    scopeId: binding.scopeId,
    landed,
    files: files.landed,
    ...(files.skipped.length > 0 ? { skipped: files.skipped } : {}),
    pending: pending || files.queued > 0,
  });

  if (budget.details <= 0 || expired()) {
    files.throwIfFailed();
    return finish(0, true);
  }

  const since = cursor ? (cursor.since === null ? null : Date.parse(cursor.since)) : firstPassSince(binding, nowMs);
  const through = cursor?.pending ? Number(cursor.pending.through) : -Infinity;
  const filter = since === null ? null : lastModifiedFilter(since - INVOICE_OVERLAP_MS);
  const changed = [...new Set(await api.supplierInvoicesModifiedSince(filter))]
    .filter((n) => Number(n) > through)
    .sort((a, b) => Number(a) - Number(b));
  const batch = changed.slice(0, budget.details);
  if (batch.length === 0) {
    files.throwIfFailed();
    return finish(0, changed.length > 0);
  }
  budget.details -= batch.length;

  // Read in number order, stopping at the first read that fails. What was read before it still
  // lands and the cursor moves past it, so a failure costs the pass the rest of its batch, never
  // the progress already made. A 404 is an invoice deleted between the list and the read: there
  // is nothing to land, so it is stepped over. Any other failure (a 429 past its retries, a 5xx,
  // an invoice our schema cannot read) ends the pass naming the invoice, and the next pass
  // starts from it. An invoice that can never be read therefore fails every pass by number
  // instead of being dropped, because a skipped one would not reach the vertical until someone
  // edited it in Fortnox.
  const invoices: FortnoxSupplierInvoicePage['invoices'] = [];
  let handled = 0;
  let failure: Error | null = null;
  for (const givenNumber of batch) {
    try {
      invoices.push(landedInvoice(await api.supplierInvoice(givenNumber)));
    } catch (err) {
      if (!(err instanceof FortnoxApiError && err.status === 404)) {
        failure = new Error(`supplier invoice ${givenNumber}: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
    }
    handled += 1;
    // Checked after a read, so every pass makes progress however slow the list was.
    if (expired()) break;
  }
  if (handled === 0) throw failure!;

  if (invoices.length > 0) {
    const company = await api.companyInformation();
    const payload = fortnoxSupplierInvoicePage.parse({
      connectionId,
      company: { name: company.CompanyName, organizationNumber: company.OrganizationNumber },
      invoices,
    });
    // The connection acting as itself (#97), gated on the grant the binding was seated with.
    const scope = await host.getConnectorScope(connectionId, scopeRef);
    files.ask(await scope.invoke(binding.operation, payload));
  }

  const more = changed.length > handled;
  const startedAt = cursor?.pending?.startedAt ?? new Date(nowMs).toISOString();
  const synced: FortnoxBinding = withFiles({
    ...binding,
    invoiceSync: {
      since: more ? (since === null ? null : new Date(since).toISOString()) : startedAt,
      syncedAt: new Date(nowMs).toISOString(),
      landed: invoices.length,
      ...(more ? { pending: { startedAt, through: batch[handled - 1]! } } : {}),
    },
  });
  await host.admin.putConnectorState(connectionId, bindingKey(binding.scopeId), synced);
  files.moved = false;
  await files.drain();
  await saveFiles(synced);
  if (failure) throw failure;
  files.throwIfFailed();
  return finish(invoices.length, more);
}

/** Where an invoice binding's first pass starts: a number of days back, or `null` for everything. */
const firstPassSince = (binding: FortnoxBinding, nowMs: number): number | null =>
  binding.firstPass === 'all' ? null : nowMs - (binding.firstPass ?? INVOICE_FIRST_LOOKBACK_DAYS) * 86_400_000;

const triedKey = (entry: FortnoxInvoiceFileEntry): string =>
  JSON.stringify([entry.givenNumber, entry.entity.entityType, entry.entity.entityId]);

/**
 * The invoice files one pass reads: the queue the binding carries, plus what the landing asks for.
 *
 * Each queued invoice costs its connections plus one read per file. A failure names the invoice and
 * moves it to the back, so one file that cannot be read does not stop the others. A refusal stops
 * them all: it is the company's consent, and every other file would answer the same.
 */
class InvoiceFiles {
  private queue: FortnoxInvoiceFileEntry[];
  private attachments: Awaited<ReturnType<ScopeHost['getConnectorAttachments']>> | undefined;
  private failure: Error | null = null;
  /** The company's consent refused a read, so the rest of the pass asks nothing more. */
  private refused = false;
  /**
   * What failed this pass, by invoice and entity, so the drain after the landing does not read it
   * again. A landing that names another entity for the invoice is a new request, and is read.
   */
  private readonly tried = new Set<string>();
  /** Files landed so far this pass. */
  landed = 0;
  readonly skipped: { givenNumber: string; reason: string }[] = [];
  /** True once the queue differs from what the binding holds. */
  moved = false;

  constructor(
    private readonly host: ScopeHost,
    private readonly connectionId: ConnectionId,
    private readonly scopeId: string,
    private readonly scopeRef: ScopeId,
    private readonly api: FortnoxApi,
    private readonly budget: { details: number },
    private readonly expired: () => boolean,
    held: readonly FortnoxInvoiceFileEntry[] = [],
  ) {
    this.queue = [...held];
  }

  get queued(): number {
    return this.queue.length;
  }

  /** The binding's `files` field: absent when nothing is queued. */
  held(): { files?: FortnoxInvoiceFileEntry[] } {
    return this.queue.length > 0 ? { files: this.queue } : {};
  }

  /** Queue what a landing asked for. Re-asking for a queued invoice takes its newer entity. */
  ask(answer: unknown): void {
    const asked = fortnoxSupplierInvoiceLandingAnswer.safeParse(answer);
    if (!asked.success) return;
    for (const { givenNumber, entity } of asked.data.files ?? []) {
      const entry: FortnoxInvoiceFileEntry = { givenNumber, entity };
      const at = this.queue.findIndex((e) => e.givenNumber === givenNumber);
      if (at >= 0) this.queue[at] = { ...this.queue[at]!, entity };
      else this.queue.push(entry);
      this.moved = true;
    }
  }

  /** Read what the budget and the deadline allow. */
  async drain(): Promise<void> {
    const failed: FortnoxInvoiceFileEntry[] = [];
    while (!this.refused && this.budget.details >= INVOICE_FILE_READS && !this.expired()) {
      const at = this.queue.findIndex((e) => !this.tried.has(triedKey(e)));
      if (at < 0) break;
      const [entry] = this.queue.splice(at, 1) as [FortnoxInvoiceFileEntry];
      this.moved = true;
      try {
        if (!(await this.read(entry))) {
          // The budget or the deadline ran out between its files: it stays first, and what it
          // landed is recorded, so the next pass reads only the rest.
          this.queue.unshift(entry);
          break;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof FortnoxApiError && err.refused) {
          this.queue.unshift(entry);
          this.refused = true;
          this.failure = new Error(
            `invoice files: Fortnox refused the read (${message}). The company's consent must cover ` +
              `the connectfile and archive scopes; connect the company again.`,
          );
          break;
        }
        this.tried.add(triedKey(entry));
        failed.push(entry);
        this.failure ??= new Error(`file of supplier invoice ${entry.givenNumber}: ${message}`);
      }
    }
    this.queue.push(...failed);
  }

  /** Land an invoice's files not yet landed on its entity. False when the pass ran out first. */
  private async read(entry: FortnoxInvoiceFileEntry): Promise<boolean> {
    this.budget.details -= 1;
    const connected = await this.api.supplierInvoiceFiles(entry.givenNumber);
    const key = filesLandedKey(this.scopeId, entry.givenNumber);
    const held = (await this.host.admin.getConnectorState(this.connectionId, key)) as FortnoxInvoiceFilesLanded | null | undefined;
    const sameEntity = held?.entity.entityType === entry.entity.entityType && held.entity.entityId === entry.entity.entityId;
    let landed = sameEntity ? held.fileIds : [];
    for (const file of connected) {
      if (landed.includes(file.FileId)) continue;
      if (this.budget.details < 1 || this.expired()) return false;
      this.budget.details -= 1;
      await this.land(entry, file);
      landed = [...landed, file.FileId];
      await this.host.admin.putConnectorState(this.connectionId, key, { entity: entry.entity, fileIds: landed } satisfies FortnoxInvoiceFilesLanded);
    }
    return true;
  }

  private async land(entry: FortnoxInvoiceFileEntry, file: FortnoxSupplierInvoiceFile): Promise<void> {
    const name = file.Name || `supplier-invoice-${entry.givenNumber}`;
    let read: Awaited<ReturnType<FortnoxApi['archiveFile']>>;
    try {
      read = await this.api.archiveFile(file.FileId, INVOICE_FILE_MAX_BYTES);
    } catch (err) {
      if (!(err instanceof FortnoxApiError && err.status === 404)) throw err;
      this.skipped.push({ givenNumber: entry.givenNumber, reason: `${name} is gone from the archive` });
      return;
    }
    if (read.tooLarge !== undefined) {
      this.skipped.push({ givenNumber: entry.givenNumber, reason: `${name} is ${read.tooLarge} bytes, over ${INVOICE_FILE_MAX_BYTES}` });
      return;
    }
    this.attachments ??= await this.host.getConnectorAttachments(this.connectionId, this.scopeRef);
    await this.attachments.upload({
      entity: entry.entity,
      filename: name,
      contentType: fileType(name, read.contentType),
      visibility: 'internal',
      body: read.bytes,
    });
    this.landed += 1;
  }

  throwIfFailed(): void {
    if (this.failure) throw this.failure;
  }
}

/** One Fortnox invoice as the page carries it, parsed here so a bad one is named by number. */
const landedInvoice = (invoice: FortnoxSupplierInvoice): FortnoxSupplierInvoicePage['invoices'][number] =>
  fortnoxSupplierInvoicePage.shape.invoices.element.parse({
    givenNumber: invoice.GivenNumber,
    supplierNumber: invoice.SupplierNumber,
    supplierName: invoice.SupplierName,
    invoiceNumber: invoice.InvoiceNumber,
    invoiceDate: invoice.InvoiceDate,
    dueDate: invoice.DueDate,
    total: { amount: invoice.Total, currency: invoice.Currency },
    ...(invoice.Balance === null ? {} : { balance: { amount: invoice.Balance, currency: invoice.Currency } }),
    ...(invoice.VAT === null ? {} : { vat: { amount: invoice.VAT, currency: invoice.Currency } }),
    ocr: invoice.OCR || null,
    booked: invoice.Booked,
    cancelled: invoice.Cancelled,
    credit: invoice.Credit,
    paymentPending: invoice.PaymentPending,
    comments: invoice.Comments || null,
    commentLog: invoice.CommentLog.map((c) => ({ comment: c.Comment, createdAt: c.CreatedAt || null, userName: c.UserName || null })),
    voucher:
      invoice.VoucherNumber === null || invoice.VoucherNumber === '0'
        ? null
        : { series: invoice.VoucherSeries || null, number: Number(invoice.VoucherNumber), year: invoice.VoucherYear === null ? null : Number(invoice.VoucherYear) },
    project: invoice.Project || null,
    costCentre: invoice.CostCenter || null,
    rows: invoice.SupplierInvoiceRows.map((row) => ({
      account: row.Account,
      accountDescription: row.AccountDescription || null,
      costCentre: row.CostCenter || null,
      project: row.Project || null,
      transactionInformation: row.TransactionInformation || null,
      amount: { amount: addDecimal(row.Debit, mulDecimal('-1', row.Credit)), currency: 'SEK' },
    })),
  });

/** What one sweep pass over a connection did. */
export interface FortnoxSweepResult {
  found: number;
  /** Ledger bindings whose books changed and landed. */
  synced: FortnoxSyncResult[];
  /** Invoice bindings that landed invoices or files. */
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
  // One budget and one rate window per pass: every binding on this connection reads the same company.
  const budget = { details: INVOICE_DETAILS_PER_PASS };
  const pass = { ...options, rateWindow: options.rateWindow ?? [] };

  for (const { value } of rows) {
    // A tombstoned binding (`unbindFortnoxScope`) — present as a row, not a target.
    if (value === null || typeof value !== 'object') continue;
    const binding = value as FortnoxBinding;
    result.found += 1;
    if (binding.kind !== undefined && binding.kind !== 'ledger' && binding.kind !== 'supplier-invoice') {
      result.failed.push({ scopeId: binding.scopeId, error: `unknown Fortnox binding kind '${String(binding.kind)}'; upgrade this platform before polling this binding` });
      continue;
    }
    // The same for the form, so a file binding is never polled as sums of a shape its landing refuses.
    if (binding.form !== undefined && binding.form !== 'summary' && binding.form !== 'sie') {
      result.failed.push({ scopeId: binding.scopeId, error: `unknown Fortnox ledger form '${String(binding.form)}'; upgrade this platform before polling this binding` });
      continue;
    }
    try {
      if (binding.kind === 'supplier-invoice') {
        const r = await syncFortnoxSupplierInvoices(host, connectionId, binding, { ...pass, budget });
        if (r.landed > 0 || r.files > 0 || r.skipped) result.invoices.push(r);
        else result.unchanged += 1;
        continue;
      }
      if (binding.form === 'sie') {
        const { synced, failed } = await syncFortnoxSieFiles(host, connectionId, binding, pass);
        const landed = synced.filter((r) => r.changed);
        result.synced.push(...landed);
        for (const f of failed) {
          result.failed.push({
            scopeId: binding.scopeId,
            error: `financial year ${f.financialYearId}: ${f.error instanceof Error ? f.error.message : String(f.error)}`,
          });
        }
        if (landed.length === 0 && failed.length === 0) result.unchanged += 1;
        continue;
      }
      const r = await syncFortnoxScope(host, connectionId, binding, pass);
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
        // A file binding may have landed an older year while its current one is refused.
        status: b.lastSync || b.invoiceSync || (b.yearSync && Object.keys(b.yearSync).length > 0) ? 'synced' : 'bound — not yet synced',
        at: instant.parse(b.lastSync?.syncedAt ?? b.invoiceSync?.syncedAt ?? b.boundAt),
        facts: [
          { label: 'Lands through', value: b.operation },
          { label: 'Permission', value: b.permission },
          ...(b.lastSync
            ? [
                // A file binding lands no balance rows, so it has no count to show.
                ...(b.form === 'sie' ? [] : [{ label: 'Balances', value: String(b.lastSync.balances) }]),
                { label: 'Financial year', value: String(b.lastSync.financialYearId) },
                // The content hash IS the sync identity, so an operator comparing two
                // scopes can tell "same books" from "same moment" at a glance.
                { label: 'Content hash', value: b.lastSync.contentHash.slice(0, 12) },
              ]
            : []),
          ...(b.yearSync ? [{ label: 'Financial years held', value: String(Object.keys(b.yearSync).length) }] : []),
          ...(b.files?.length ? [{ label: 'Invoice files waiting', value: String(b.files.length) }] : []),
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
