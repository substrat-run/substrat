import { z } from 'zod';
import {
  connectionActivity,
  connectionId as connectionIdSchema,
  instant,
  money,
  scopeId as scopeIdSchema,
  tenantId as tenantIdSchema,
  type ConnectionActivity,
  type ConnectionProbe,
  type ConnectionId,
} from '@substrat-run/contracts';
import type {
  ConnectorConnection,
  FetchLike,
  HostAdmin,
  ScopeHost,
} from '@substrat-run/kernel';
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
export { FortnoxMock, type FortnoxMockOptions } from './mock.js';

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
 * **Refuses a binding whose grant is missing**, which is the whole reason this is a
 * function rather than a config object. The alternative — write the binding, discover
 * at sweep time that the connection cannot invoke the operation — fails in the worst
 * possible place: after a year of bookkeeping has been fetched, in a background timer
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
    now?: () => number;
  },
): Promise<FortnoxBinding> {
  const tenant = tenantIdSchema.parse(input.tenantId);
  const scope = scopeIdSchema.parse(input.scopeId);

  // On the host, not `admin`: this is the same projection the permission checker reads,
  // so a binding is verified against the tuples that will actually gate the invoke —
  // not against a directory row that may not have reached the scope yet.
  const granted = await host.connectionGrantsInScope(tenant, scope);
  const held = granted.some(
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
  const admin = host.admin;
  const conn = await openFortnoxConnection(
    admin,
    options.fetch,
    binding.tenantId,
    binding.vertical,
    options.timeoutMs ?? 30_000,
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

/** What one sweep pass over a connection did. */
export interface FortnoxSweepResult {
  found: number;
  synced: FortnoxSyncResult[];
  unchanged: number;
  failed: { scopeId: string; error: string }[];
}

/**
 * Poll Fortnox for every scope this connection is bound to — the {@link ConnectorSweeper}
 * a deployment schedules.
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
  const result: FortnoxSweepResult = { found: 0, synced: [], unchanged: 0, failed: [] };

  for (const { value } of rows) {
    // A tombstoned binding (`unbindFortnoxScope`) — present as a row, not a target.
    if (value === null || typeof value !== 'object') continue;
    const binding = value as FortnoxBinding;
    result.found += 1;
    try {
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
    expiresAt: null,
    fetch: (input, init) =>
      options.fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
  };
  return probeWith(conn, options);
}

/** Probe the credential a live connection already holds. Verifying is itself a use. */
export async function probeFortnoxConnection(
  host: ScopeHost,
  connection: { tenantId: string; vertical: string },
  options: FortnoxConnectorOptions,
): Promise<ConnectionProbe> {
  const conn = await openFortnoxConnection(
    host.admin,
    options.fetch,
    connection.tenantId,
    connection.vertical,
    options.timeoutMs ?? 15_000,
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
        status: b.lastSync ? 'synced' : 'bound — not yet synced',
        at: instant.parse(b.lastSync?.syncedAt ?? b.boundAt),
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

/** Open the live Fortnox connection for a (tenant, vertical), with health recorded. */
async function openFortnoxConnection(
  admin: HostAdmin,
  fetchImpl: FetchLike,
  tenant: string,
  vertical: string,
  timeoutMs: number,
): Promise<ConnectorConnection> {
  const parsedTenant = tenantIdSchema.parse(tenant);
  const open = await admin.openConnection(parsedTenant, vertical, 'fortnox');
  if (!open) {
    throw new Error(
      `no live 'fortnox' connection for tenant ${tenant} / vertical '${vertical}'`,
    );
  }
  return {
    ...open,
    fetch: async (input, init) => {
      try {
        const res = await fetchImpl(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
        await admin.recordConnectionUse(
          open.id,
          res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status} from fortnox` },
        );
        return res;
      } catch (err) {
        await admin.recordConnectionUse(open.id, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
  };
}
