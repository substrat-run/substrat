import { z } from 'zod';
import {
  connectionActivity,
  connectionId as connectionIdSchema,
  instant,
  scopeId as scopeIdSchema,
  tenantId as tenantIdSchema,
  type ConnectionActivity,
  type ConnectionCredential,
  type ConnectionProbe,
  type ConnectionId,
} from '@substrat-run/contracts';
import type { ConnectorConnection, FetchLike, HostAdmin, ScopeHost } from '@substrat-run/kernel';
import { PlanimaApi, PlanimaApiError, PLANIMA_API_BASE, planimaSecret } from './api.js';
import {
  actionFactIn,
  buildingFact,
  componentFact,
  facilityFact,
  planimaActionFact,
  planimaBuildingFact,
  planimaComponentFact,
  planimaFacilityFact,
} from './plan.js';

// Web-standard everywhere this runs (Node, Workers); declared locally so the
// connector pulls in no platform typings, exactly as `connector-fortnox` does.
declare const AbortSignal: { timeout(ms: number): unknown };
declare const crypto: { subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> } };
declare const TextEncoder: new () => { encode(input: string): Uint8Array };

export {
  PlanimaApi,
  PlanimaApiError,
  PLANIMA_API_BASE,
  PLANIMA_ACCEPT,
  PLANIMA_MAX_PAGE,
  PLANIMA_ACTION_STATUSES,
  planimaSecret,
  type PlanimaAction,
  type PlanimaApiOptions,
  type PlanimaBuilding,
  type PlanimaComponent,
  type PlanimaFacility,
  type PlanimaOrganization,
  type PlanimaSecret,
} from './api.js';
export {
  decimalOf,
  planimaActionFact,
  planimaBuildingFact,
  planimaComponentFact,
  planimaDecimal,
  planimaFacilityFact,
  type PlanimaActionFact,
  type PlanimaBuildingFact,
  type PlanimaComponentFact,
  type PlanimaFacilityFact,
} from './plan.js';
export { PlanimaMock, type PlanimaMockOptions } from './mock.js';

/**
 * The Planima connector — the INBOUND half of maintenance-plan integration.
 *
 * [Planima](https://planima.se/) is a Swedish web application for planned facility
 * maintenance (sv. *underhållsplan*). A plan is a tree — organization → facility →
 * building → component — with **actions** hanging off it: dated, priced, categorized
 * work a property owner intends to do in a given year.
 *
 * ## Poll-only, and that is a design fact rather than an omission
 *
 * Like `connector-fortnox` and unlike `connector-scrive`, this connector registers no
 * event handler at all, because nothing inside a scope initiates the work. A vertical
 * does not *ask* for next year's maintenance plan the way it asks for a signature; the
 * plan changes in Planima — a surveyor walks a roof and moves an action from 2031 to
 * 2027 — and the platform finds out by looking.
 *
 * So there is no `registerPlanimaConnector`. {@link sweepPlanimaPlan} is the whole
 * trigger surface, and a deployment binds it into the platform sweeper exactly as it
 * binds Fortnox's.
 *
 * ## Read-only, and the credential is why
 *
 * Planima's API can create and update organizations, facilities, buildings and
 * components. This connector uses none of it. A Planima token carries the full access
 * of the user who minted it — there are no scopes to narrow — so the narrowing that
 * matters is operational: hand this connector a **read-only user's token** and the
 * blast radius of a leaked credential is a maintenance plan someone could already see.
 * A write path would forfeit that, and no vertical has asked for one; when one does,
 * it belongs behind an event and a dispatch, in the shape `connector-scrive` already
 * has.
 *
 * ## Where the data lands, and why the connector does not decide
 *
 * A sweep has no delivered event, so it has neither a scope to write to nor authority
 * to write with. That is declared **once**, explicitly, by {@link bindPlanimaScope}:
 * which scope, which operation to land the plan through, and which permission that
 * operation checks.
 *
 * The operation is the *consumer's*, and that is deliberate. What comes out of Planima
 * is neutral fact — a component, a year, a price, a status string. What a business
 * *means* by them (which status counts as committed spend, which category rolls into
 * which budget line, whether a deferred action still books) is vocabulary, and
 * vocabulary is the vertical's layer.
 */

/**
 * The standing grants this connector requires — deliberately EMPTY, with a mechanism
 * in place of a declaration.
 *
 * The reasoning is `FORTNOX_CONNECTION_GRANTS`'s, and it applies here for the same
 * reason: the permission this connector needs is whatever the *consumer's* landing
 * operation checks, which differs per vertical and is unknown at this package's build
 * time. So the check moves from build time to bind time — {@link bindPlanimaScope}
 * verifies the connection actually holds the named permission in the named scope and
 * **refuses the binding otherwise**, naming what is missing. A sweep can therefore
 * never be configured into a state where it fetches a whole maintenance plan and
 * cannot write it down.
 */
export const PLANIMA_CONNECTION_GRANTS = [] as const;

/** The connector-state key prefix every binding lives under — what the sweep enumerates. */
const BINDING_PREFIX = 'planima:binding:';
const bindingKey = (scope: string): string => `${BINDING_PREFIX}${scope}`;

/**
 * The currency a Planima plan's prices are in — a DECLARED fact, because the API does
 * not carry one.
 *
 * Planima sends `unit_price: 1200` and nothing else: no currency field on the action,
 * the facility, the organization or the account. The product is Swedish and its prices
 * are kronor, so `SEK` is the right default — but it is a default this connector chose,
 * not a value it read, and Substrat money is a `{ amount, currency }` pair that cannot
 * be built without one. Naming it on the binding is what keeps that choice visible and
 * overridable instead of hard-coded three files down.
 */
export const PLANIMA_DEFAULT_CURRENCY = 'SEK';

/**
 * How many years past the current one a sweep reads when a binding names no window.
 *
 * A Swedish maintenance plan is conventionally drawn 30 years out, and almost nothing
 * consumes all of it: the far years are placeholders that move every time a surveyor
 * revisits. Ten years is the horizon a budget actually uses, and — because the window
 * is part of the sync's identity — a shorter one also means the far-future churn does
 * not make every sweep look like a change.
 */
export const PLANIMA_DEFAULT_HORIZON_YEARS = 10;

/** How many action rows ride one `invoke`. */
const PAGE_SIZE = 500;

/**
 * What the connector remembers about one scope it syncs into.
 *
 * Directory-side (`putConnectorState`) for the same reason Fortnox's binding is: this
 * is a connector's own bookkeeping, it must survive across sweeps, and it must be
 * readable without entering a scope.
 */
export interface PlanimaBinding {
  scopeId: string;
  tenantId: string;
  /** The scope's vertical — half the key that reopens the connection to poll. */
  vertical: string;
  /**
   * The operation the plan is landed through, e.g. `'maintenance/record-plan'`.
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
  /**
   * WHICH Planima organization this scope syncs, or `null` for every one the token can
   * see.
   *
   * A token belongs to a Planima customer account, and an account may hold several
   * organizations — a municipality with one per administration, say. `null` is the
   * right default for the common case of one organization per account, and naming an id
   * is what keeps two scopes on one token from each landing the other's buildings.
   */
  organizationId: number | null;
  /** The currency the plan's prices are read as — see {@link PLANIMA_DEFAULT_CURRENCY}. */
  currency: string;
  /**
   * A FIXED year window, or `null` to read a rolling one from `horizonYears`.
   *
   * Fixed is for a back-fill or a frozen budget year; rolling is what a standing sync
   * wants, because "the next ten years" should still mean that in January.
   */
  window: { fromYear: number; toYear: number } | null;
  /** Years past the current one, when `window` is `null`. */
  horizonYears: number;
  boundAt: string;
  /** Set after the first successful sync — the cursor that makes a re-sync cheap. */
  lastSync?: {
    syncedAt: string;
    /**
     * SHA-256 of the assembled plan AND the window it was read through. Unchanged ⇒
     * the sync is skipped without landing.
     *
     * The window is in here for the reason Fortnox's is: what lands is the plan
     * *filtered to* the window, so the same rows read through a different window are a
     * different result, and hashing the rows alone would make an explicit back-fill
     * over an already-synced organization a silent no-op. It matters more here than
     * there, because this window MOVES on its own — a rolling horizon crosses a new
     * year every January, and without the window in the hash that year's actions would
     * not land until something else about the plan happened to change.
     */
    contentHash: string;
    facilities: number;
    actions: number;
  };
}

/**
 * One page of a maintenance plan, as it crosses into a scope.
 *
 * Parsed with this schema on the way OUT, before every `invoke`. The engine-seam rule
 * (`returns()`) exists because a value crossing a version boundary must be pinned to a
 * published shape rather than to whatever the code currently produces, and a connector
 * seam is the same boundary with a network in the middle: a vertical compiled against
 * one version of this package and running against another must get a throw, never a
 * silently-reshaped plan on a screen.
 *
 * ## The paging shape, and how a consumer reads it
 *
 * Pages are global across one sync and each page names exactly one facility. A
 * facility's buildings and components ride its **first** page only (`facilityHead`) —
 * they are the same on every page of that facility, and repeating a component list
 * across ten pages of actions is bytes through a clone pipe for nothing. So a consumer
 * upserts on `facilityHead`, appends actions on every page, and commits or swaps when
 * `final` arrives.
 */
export const planimaPlanPage = z.object({
  /**
   * Identifies this sync RUN, and it is the content hash rather than a ULID on purpose:
   * two syncs of an unchanged plan produce the same `syncId`, so a consumer's upsert is
   * naturally idempotent and a redelivered page cannot double a cost.
   */
  syncId: z.string().min(1),
  connectionId: z.string().min(1),
  /** The organization the facility belongs to, when Planima nested one on it. */
  organization: z.object({ id: z.number().int(), name: z.string() }).nullable(),
  /**
   * The facility this page carries — or `null` on a CLEAR page.
   *
   * A sync that finds no facilities at all still has something to say, and saying
   * nothing is the one answer that corrupts a consumer: it commits or swaps on `final`,
   * so a pass that lands zero pages leaves last month's facilities and actions in place
   * for ever, while the cursor records the empty plan as synced and no later sweep
   * repairs it. So an empty plan lands exactly one page — `facility: null`,
   * `actions: []`, `final: true` — which reads as "this plan is now empty" rather than
   * as silence.
   */
  facility: planimaFacilityFact.nullable(),
  /** The year range the actions on this page were read through — inclusive both ends. */
  window: z.object({ fromYear: z.number().int(), toYear: z.number().int() }),
  /** The currency every `Money` on this page is denominated in; declared, not read — see the binding. */
  currency: z.string(),
  page: z.number().int().nonnegative(),
  pageCount: z.number().int().positive(),
  /** True on the last page of the whole sync — the signal a consumer commits or swaps on. */
  final: z.boolean(),
  /** True on this facility's FIRST page, where its buildings and components ride. */
  facilityHead: z.boolean(),
  buildings: z.array(planimaBuildingFact).default([]),
  components: z.array(planimaComponentFact).default([]),
  actions: z.array(planimaActionFact),
});
export type PlanimaPlanPage = z.infer<typeof planimaPlanPage>;

export interface PlanimaConnectorOptions {
  fetch: FetchLike;
  apiBase?: string;
  timeoutMs?: number;
  /** Injected so a test can assert elapsed time without sleeping. */
  now?: () => number;
  /** Injected for the same reason — the rate-limit throttle waits through this. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * A sliding rate-limit window shared by every client built during one sweep.
   *
   * `sweepPlanimaPlan` creates one and threads it through, because Planima meters per
   * TOKEN: without it, each bound scope's client starts with an empty window and the
   * second scope's requests pile on top of the first's.
   */
  rateWindow?: number[];
}

/**
 * Declare that a connection should sync one scope — the one-time setup a poll-only
 * connector needs in place of a dispatch.
 *
 * **Refuses a binding whose grant is missing**, which is the whole reason this is a
 * function rather than a config object. The alternative — write the binding, discover
 * at sweep time that the connection cannot invoke the operation — fails in the worst
 * possible place: after a whole maintenance plan has been fetched against a
 * 10-request-per-10-seconds budget, in a background timer nobody is watching. Here it
 * fails in the operator's hands, naming the permission to grant.
 */
export async function bindPlanimaScope(
  host: ScopeHost,
  input: {
    connectionId: ConnectionId;
    tenantId: string;
    scopeId: string;
    vertical: string;
    operation: string;
    permission: string;
    organizationId?: number | null;
    currency?: string;
    window?: { fromYear: number; toYear: number } | null;
    horizonYears?: number;
    now?: () => number;
  },
): Promise<PlanimaBinding> {
  const tenant = tenantIdSchema.parse(input.tenantId);
  const scope = scopeIdSchema.parse(input.scopeId);

  if (input.window && input.window.toYear < input.window.fromYear) {
    throw new Error(
      `window ${input.window.fromYear}..${input.window.toYear} ends before it starts — ` +
        `Planima would return nothing and the sync would look like an empty plan`,
    );
  }
  const horizonYears = input.horizonYears ?? PLANIMA_DEFAULT_HORIZON_YEARS;
  if (!Number.isInteger(horizonYears) || horizonYears < 0) {
    throw new Error(`horizonYears must be a non-negative integer, got ${String(input.horizonYears)}`);
  }

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
        `a sweep would fetch the maintenance plan and then fail to land it. Grant it first ` +
        `(grantToConnection), then bind.`,
    );
  }

  const binding: PlanimaBinding = {
    scopeId: input.scopeId,
    tenantId: input.tenantId,
    vertical: input.vertical,
    operation: input.operation,
    permission: input.permission,
    organizationId: input.organizationId ?? null,
    currency: input.currency ?? PLANIMA_DEFAULT_CURRENCY,
    window: input.window ?? null,
    horizonYears,
    boundAt: new Date(input.now?.() ?? Date.now()).toISOString(),
  };
  await host.admin.putConnectorState(input.connectionId, bindingKey(input.scopeId), binding);
  return binding;
}

/** Every scope this connection syncs into. */
export async function listPlanimaBindings(
  host: ScopeHost,
  connectionId: ConnectionId,
): Promise<PlanimaBinding[]> {
  const rows = await host.admin.listConnectorState(connectionId, BINDING_PREFIX);
  // Tombstones filtered, exactly as the sweep and the activity projection do.
  // `unbindPlanimaScope` writes `null` under the same key, and casting that to
  // `PlanimaBinding` hands a caller a typed value that throws on the first property
  // read — a lie the type system cannot catch.
  return rows
    .filter((r) => r.value !== null && typeof r.value === 'object')
    .map((r) => r.value as PlanimaBinding);
}

/**
 * Stop syncing one scope. The binding row is replaced with a tombstone rather than
 * removed, because `putConnectorState` is the only verb this surface has — and an
 * unbound scope that a later sweep silently re-adopts would be worse than a visible
 * dead row.
 */
export async function unbindPlanimaScope(
  host: ScopeHost,
  connectionId: ConnectionId,
  scopeId: string,
): Promise<void> {
  await host.admin.putConnectorState(connectionId, bindingKey(scopeId), null);
}

/** What one scope's sync did. */
export interface PlanimaSyncResult {
  scopeId: string;
  /** False when the plan was identical to the last sync — nothing was landed. */
  changed: boolean;
  syncId: string;
  window: { fromYear: number; toYear: number };
  facilities: number;
  actions: number;
  pages: number;
}

const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

/** One facility's whole slice of the plan, assembled before anything is hashed or landed. */
interface FacilityPlan {
  facility: ReturnType<typeof facilityFact>;
  organization: { id: number; name: string } | null;
  buildings: ReturnType<typeof buildingFact>[];
  components: ReturnType<typeof componentFact>[];
  actions: ReturnType<typeof actionFactIn>[];
}

/** The window a binding reads through, resolved against the clock for a rolling one. */
export function windowFor(binding: PlanimaBinding, nowMs: number): { fromYear: number; toYear: number } {
  if (binding.window) return binding.window;
  const fromYear = new Date(nowMs).getUTCFullYear();
  return { fromYear, toYear: fromYear + binding.horizonYears };
}

/**
 * Sync ONE bound scope: read the plan, hash it, and land it through the binding's
 * operation as the connection itself (#97).
 *
 * Idempotent and cheap to re-land on a no-op. The assembled plan is hashed before
 * anything is landed, and an unchanged hash returns `changed: false` without a single
 * `invoke` — which matters because a sweep runs on a timer and most passes find a plan
 * nobody has touched.
 *
 * Note what that does NOT save: the provider reads still happen, because Planima offers
 * no collection-level `updated_at` or ETag to ask "has anything changed" cheaply. The
 * skip saves the writes and the events, not the round trips. Being straight about that
 * is what makes the sweep interval a real decision — every pass costs
 * `1 + 3 × facilities` requests against a 10-per-10-second budget.
 */
export async function syncPlanimaScope(
  host: ScopeHost,
  connectionId: ConnectionId,
  binding: PlanimaBinding,
  options: PlanimaConnectorOptions & { window?: { fromYear: number; toYear: number } },
): Promise<PlanimaSyncResult> {
  const admin = host.admin;
  const conn = await openPlanimaConnection(
    admin,
    options.fetch,
    binding.tenantId,
    binding.vertical,
    options.timeoutMs ?? 30_000,
    // The binding's own connection, or nothing. See `openPlanimaConnection`.
    connectionId,
  );
  const api = new PlanimaApi(conn, {
    apiBase: options.apiBase,
    now: options.now,
    sleep: options.sleep,
    rateWindow: options.rateWindow,
  });

  const nowMs = options.now?.() ?? Date.now();
  const window = options.window ?? windowFor(binding, nowMs);
  const currency = binding.currency || PLANIMA_DEFAULT_CURRENCY;

  const facilities = await api.facilities(binding.organizationId ?? undefined);
  // Sorted by id before anything else touches them. Planima documents no ordering, so
  // two sweeps could legitimately return the same facilities in a different order — and
  // an unsorted hash would then read as a changed plan and re-land the whole thing.
  // The same reasoning applies to every list below.
  facilities.sort((a, b) => a.id - b.id);

  const plans: FacilityPlan[] = [];
  for (const facility of facilities) {
    // Sequential, not `Promise.all`: the client's rate-limit window is a per-instance
    // list, so three concurrent requests would each see an empty window and fire at
    // once. Against a 10-per-10-second budget that is how a sweep of a handful of
    // facilities starts eating 429s.
    const buildings = await api.buildings(facility.id);
    const components = await api.components(facility.id);
    const actions = await api.actions(facility.id, window);
    buildings.sort((a, b) => a.id - b.id);
    components.sort((a, b) => a.id - b.id);
    actions.sort((a, b) => a.id - b.id);
    plans.push({
      facility: facilityFact(facility),
      organization: facility.organization
        ? { id: facility.organization.id, name: facility.organization.name }
        : null,
      buildings: buildings.map(buildingFact),
      components: components.map(componentFact),
      actions: actions.map((a) => actionFactIn(a, facility.id, currency)),
    });
  }

  // The WINDOW and the CURRENCY are part of the sync's identity, not just the rows.
  //
  // The window because what lands is the plan filtered to it (Fortnox's lesson, and
  // sharper here because a rolling window moves by itself every January). The currency
  // because it is a declared value rather than a read one: re-binding a scope from SEK
  // to EUR changes every `Money` that lands while leaving every provider row identical,
  // and a hash over the rows alone would call that no change at all.
  const contentHash = await sha256Hex(
    JSON.stringify({ window, currency, organizationId: binding.organizationId, plans }),
  );
  const actionCount = plans.reduce((n, p) => n + p.actions.length, 0);
  if (binding.lastSync?.contentHash === contentHash) {
    return {
      scopeId: binding.scopeId,
      changed: false,
      syncId: contentHash,
      window,
      facilities: plans.length,
      actions: actionCount,
      pages: 0,
    };
  }

  // Every page of every facility, counted BEFORE the first invoke, because `pageCount`
  // and `final` are on page 0 and a consumer swapping a plan atomically needs to know
  // from the first page how many are coming.
  //
  // Floored at one: a plan with no facilities still lands a single CLEAR page. Landing
  // nothing would leave a consumer holding the previous sync's rows for ever, because
  // it swaps on `final` and no `final` would ever arrive — while the cursor below
  // recorded the empty plan as synced, so no later sweep would repair it either.
  const pageCount = Math.max(
    1,
    plans.reduce((n, p) => n + Math.max(1, Math.ceil(p.actions.length / PAGE_SIZE)), 0),
  );

  // The connection acting as itself (#97). Refuses a scope in another tenant or running
  // another vertical by construction, and the invoke below is gated on the connection's
  // own grant — the one `bindPlanimaScope` verified.
  const scope = await host.getConnectorScope(connectionId, scopeIdSchema.parse(binding.scopeId));

  if (plans.length === 0) {
    // "This plan is now empty", said explicitly. Every facility deleted, an
    // organization filter that matches nothing, a token whose access was narrowed —
    // all of them arrive here, and all of them are a fact the consumer needs.
    await scope.invoke(
      binding.operation,
      planimaPlanPage.parse({
        syncId: contentHash,
        connectionId,
        organization: null,
        facility: null,
        window,
        currency,
        page: 0,
        pageCount: 1,
        final: true,
        facilityHead: false,
        buildings: [],
        components: [],
        actions: [],
      }),
    );
  }

  let page = 0;
  for (const plan of plans) {
    const facilityPages = Math.max(1, Math.ceil(plan.actions.length / PAGE_SIZE));
    for (let i = 0; i < facilityPages; i += 1) {
      const payload = planimaPlanPage.parse({
        syncId: contentHash,
        connectionId,
        organization: plan.organization,
        facility: plan.facility,
        window,
        currency,
        page,
        pageCount,
        final: page === pageCount - 1,
        facilityHead: i === 0,
        buildings: i === 0 ? plan.buildings : [],
        components: i === 0 ? plan.components : [],
        actions: plan.actions.slice(i * PAGE_SIZE, (i + 1) * PAGE_SIZE),
      });
      await scope.invoke(binding.operation, payload);
      page += 1;
    }
  }

  const synced: PlanimaBinding = {
    ...binding,
    lastSync: {
      syncedAt: new Date(nowMs).toISOString(),
      contentHash,
      facilities: plans.length,
      actions: actionCount,
    },
  };
  // Written only AFTER every page landed, so a failure mid-way leaves the cursor at the
  // previous hash and the next sweep retries the whole plan rather than resuming into a
  // half-written one.
  await admin.putConnectorState(connectionId, bindingKey(binding.scopeId), synced);

  return {
    scopeId: binding.scopeId,
    changed: true,
    syncId: contentHash,
    window,
    facilities: plans.length,
    actions: actionCount,
    pages: pageCount,
  };
}

/** What one sweep pass over a connection did. */
export interface PlanimaSweepResult {
  found: number;
  synced: PlanimaSyncResult[];
  unchanged: number;
  failed: { scopeId: string; error: string }[];
}

/**
 * Poll Planima for every scope this connection is bound to — the sweeper a deployment
 * schedules.
 *
 * A timer calls this; it holds no timer itself. That keeps the trigger a deployment
 * concern (`startPlatformSweeper` on node, `definePlatformSweeperDO`'s alarm on
 * Cloudflare) and this a plain, testable function.
 *
 * Robust the way a poller must be: an unchanged plan is skipped without landing
 * anything, and a failure on one scope is recorded and stepped over rather than sinking
 * the pass — one vertical's missing grant must not stop another tenant's plan syncing.
 */
export async function sweepPlanimaPlan(
  host: ScopeHost,
  connectionId: ConnectionId,
  options: PlanimaConnectorOptions & { window?: { fromYear: number; toYear: number } },
): Promise<PlanimaSweepResult> {
  const rows = await host.admin.listConnectorState(connectionId, BINDING_PREFIX);
  const result: PlanimaSweepResult = { found: 0, synced: [], unchanged: 0, failed: [] };

  // ONE rate-limit window for the whole pass. Every binding under this connection
  // shares its token, and Planima meters per token — so a per-scope window would let
  // the second scope's first ten requests land on top of the first scope's ten.
  const rateWindow = options.rateWindow ?? [];

  for (const { value } of rows) {
    // A tombstoned binding (`unbindPlanimaScope`) — present as a row, not a target.
    if (value === null || typeof value !== 'object') continue;
    const binding = value as PlanimaBinding;
    result.found += 1;
    try {
      const r = await syncPlanimaScope(host, connectionId, binding, { ...options, rateWindow });
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
 * The probe reads `/organizations`, which is both the cheapest authenticated read
 * Planima offers and the one that answers the question an operator actually has: not
 * "is this token valid" but "does this token see the customer account I meant". A token
 * from the wrong Planima login is perfectly valid and syncs somebody else's buildings.
 */
export async function probePlanimaSecret(
  secret: Record<string, string>,
  options: PlanimaConnectorOptions,
): Promise<ConnectionProbe> {
  const parsed = planimaSecret.safeParse(secret);
  if (!parsed.success) {
    // A malformed credential IS a refusal — Planima would reject it, and there is no
    // point spending a round trip to hear so.
    return {
      ok: false,
      refused: true,
      accountRef: null,
      accountLabel: null,
      facts: [],
      error: `incomplete Planima credential: ${parsed.error.issues
        .map((i) => i.path.join('.'))
        .join(', ')}`,
    };
  }
  const timeoutMs = options.timeoutMs ?? 15_000;
  const conn: ConnectorConnection = {
    id: connectionIdSchema.parse('00000000000000000000000000'), // no row yet; never read
    tenantId: '',
    vertical: '',
    provider: 'planima',
    secret: parsed.data,
    expiresAt: null,
    fetch: (input, init) =>
      options.fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
  };
  return probeWith(conn, options);
}

/** Probe the credential a live connection already holds. Verifying is itself a use. */
export async function probePlanimaConnection(
  host: ScopeHost,
  connection: { tenantId: string; vertical: string },
  options: PlanimaConnectorOptions,
): Promise<ConnectionProbe> {
  const conn = await openPlanimaConnection(
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
  options: PlanimaConnectorOptions,
): Promise<ConnectionProbe> {
  const api = new PlanimaApi(conn, {
    apiBase: options.apiBase,
    now: options.now,
    sleep: options.sleep,
    // A probe answers a person waiting on a form. Sitting out a rate limit for tens of
    // seconds to answer them is worse than saying "busy, try again" — and a 429 is not
    // a fact about the credential, which is what a probe is for.
    maxRateLimitRetries: 0,
  });
  try {
    const organizations = await api.organizations();
    return {
      ok: true,
      refused: false,
      // Left null on purpose: a Planima token is one customer ACCOUNT's, and an account
      // may hold several organizations, so no single id names what this credential
      // reads. The dashboard catalog therefore declares no `accountRefField` and a
      // re-paste rotates the one connection in place, which is the right behaviour when
      // there is only ever one.
      accountRef: null,
      accountLabel:
        organizations.length === 1
          ? (organizations[0]?.name ?? null)
          : organizations.length === 0
            ? null
            : `${organizations.length} organizations`,
      facts: [
        { label: 'Organizations', value: String(organizations.length) },
        {
          label: 'Names',
          value:
            organizations.length === 0
              ? '— (the token is valid but sees nothing)'
              : organizations
                  .slice(0, 5)
                  .map((o) => o.name)
                  .join(', ') + (organizations.length > 5 ? `, +${organizations.length - 5} more` : ''),
        },
      ],
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      // Only "not with this token" counts. A timeout, a 429 or a 5xx says nothing about
      // the credential, and treating it as a refusal would make a Planima outage look
      // like every tenant's token going bad at once.
      refused: err instanceof PlanimaApiError && err.refused,
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
 * synced", which is the question an operator asks when a plan looks stale, and it
 * answers it without spending a provider round trip against a 10-per-10-second budget.
 */
export async function planimaConnectionActivity(
  host: ScopeHost,
  connectionId: ConnectionId,
): Promise<ConnectionActivity> {
  const rows = await host.admin.listConnectorState(connectionId, BINDING_PREFIX);
  const entries = rows
    .filter(({ value }) => value !== null && typeof value === 'object')
    .map(({ key, value }) => {
      const b = value as PlanimaBinding;
      return {
        key,
        title: `${b.vertical} — ${b.scopeId}`,
        reference: b.organizationId === null ? null : String(b.organizationId),
        status: b.lastSync ? 'synced' : 'bound — not yet synced',
        at: instant.parse(b.lastSync?.syncedAt ?? b.boundAt),
        facts: [
          { label: 'Lands through', value: b.operation },
          { label: 'Permission', value: b.permission },
          {
            label: 'Organization',
            value: b.organizationId === null ? 'all the token can see' : String(b.organizationId),
          },
          {
            label: 'Window',
            value: b.window
              ? `${b.window.fromYear}–${b.window.toYear} (fixed)`
              : `rolling, +${b.horizonYears} years`,
          },
          ...(b.lastSync
            ? [
                { label: 'Facilities', value: String(b.lastSync.facilities) },
                { label: 'Actions', value: String(b.lastSync.actions) },
                // The content hash IS the sync identity, so an operator comparing two
                // scopes can tell "same plan" from "same moment" at a glance.
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
    // what the platform synced, not what Planima has since changed, and a console that
    // blurs the two invents facts.
    live: false,
  });
}

/**
 * The stored credential, REDUCED (#605) — and for this provider that is one masked
 * field and nothing else.
 *
 * There is no identifier half to show. Fortnox can display its client id and
 * DatabaseNumber unmasked because they name the integration and the company; a Planima
 * credential is a single opaque token and every character of it is secret. So this
 * surface is honest rather than useful, and the useful answer — *which* Planima account
 * this is — comes from {@link probePlanimaConnection}, which reads the organization
 * names back from the provider.
 */
export async function planimaCredentialSummary(
  host: ScopeHost,
  connection: { tenantId: string; vertical: string },
): Promise<ConnectionCredential> {
  const open = await host.admin.openConnection(
    tenantIdSchema.parse(connection.tenantId),
    connection.vertical,
    'planima',
  );
  if (!open) {
    throw new Error(
      `no live 'planima' connection for tenant ${connection.tenantId} / vertical '${connection.vertical}'`,
    );
  }
  const secret = planimaSecret.parse(open.secret);
  return {
    fields: [{ key: 'token', label: 'API token', value: maskSecret(secret.token), masked: true }],
  };
}

/** A bullet run plus the last four — or nothing at all when there is too little to hide behind. */
const maskSecret = (value: string): string =>
  value.length < 8 ? '••••••••' : `••••••••${value.slice(-4)}`;

/** Open the live Planima connection for a (tenant, vertical), with health recorded. */
async function openPlanimaConnection(
  admin: HostAdmin,
  fetchImpl: FetchLike,
  tenant: string,
  vertical: string,
  timeoutMs: number,
  expected?: ConnectionId,
): Promise<ConnectorConnection> {
  const parsedTenant = tenantIdSchema.parse(tenant);
  const open = await admin.openConnection(parsedTenant, vertical, 'planima');
  if (!open) {
    throw new Error(`no live 'planima' connection for tenant ${tenant} / vertical '${vertical}'`);
  }
  // The credential that READS and the identity that WRITES must be the same connection.
  //
  // A binding names a `connectionId`, and that id is what opens the scope, stamps the
  // spine and is checked for the grant. The token, though, comes from
  // `openConnection(tenant, vertical, provider)` — whichever live row exists. Nothing in
  // THIS file makes those the same row; two layers below it do, and both were checked
  // rather than assumed: the directory holds a UNIQUE constraint that refuses a second
  // live connection for one (tenant, vertical, provider, account), and revoking one
  // takes its bindings with it. So a mismatch is currently unreachable.
  //
  // This is a backstop for the day that stops being true, not a fix for a live bug. It
  // is here because the invariant is load-bearing and invisible: if Planima ever gains
  // an `accountRefField` — one token per client company, the shape Fortnox already has —
  // a (tenant, vertical) grows several live connections, `openConnection` starts
  // choosing between them, and the sweep would silently read one company's plan with
  // another's credential while the audit trail named a connection that fetched nothing.
  // One comparison buys a loud refusal instead of that.
  if (expected !== undefined && open.id !== expected) {
    throw new Error(
      `binding names connection ${expected}, but the live 'planima' connection for tenant ` +
        `${tenant} / vertical '${vertical}' is ${open.id} — the credential that reads and the ` +
        `identity that writes must be the same connection. Re-bind the scope against ${open.id}.`,
    );
  }
  return {
    ...open,
    fetch: async (input, init) => {
      try {
        const res = await fetchImpl(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
        await admin.recordConnectionUse(
          open.id,
          res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status} from planima` },
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
