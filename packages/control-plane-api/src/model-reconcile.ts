/**
 * Model usage reconciliation (#1054, #3316): the platform's ledger against what Cloudflare saw.
 *
 * The ledger (`_substrat_model_usage`, D-59) is self-reported: a vertical's model host builds the
 * line and raises it as a `model-usage` intent, and a host that only logs it is metered nowhere.
 * Two Cloudflare datasets give a second account of the same calls, kept by someone other than the
 * caller:
 *
 * - **AI Gateway** (`aiGatewayRequestsAdaptiveGroups`): every request that passed through a gateway,
 *   with the five attribution keys the model host sends as `cf-aig-metadata`, so a call can be
 *   placed on a tenant and scope without the caller's say-so. Its `cost` is Cloudflare's estimate.
 * - **Workers AI** (`aiInferenceAdaptiveGroups`): every inference, by model and `requestSource`, but
 *   with no script, tenant or scope. Its calls that never passed a gateway can only be totalled.
 *
 * `reconcileModelDay` is the fold, pure. `createCfModelCostReader` reads the two datasets for one
 * day. `reconcileModelDays` is what the staff route answers with, and `runModelReconciliationPass`
 * is the scheduled half: once per closed day, findings filed for staff.
 *
 * The ledger is never corrected from either source. Gateway cost and sampling are estimates, and
 * the ledger prices from our own rate card by design; a difference is something a person reads.
 */
import {
  addDecimal,
  compareDecimal,
  modelReconciliationDay,
  mulDecimal,
  type ModelReconciliationDay,
  type ModelReconciliationRow,
  type ModelUsageEntry,
  type PlatformActorId,
  type ScopeId,
  tenantId,
} from '@substrat-run/contracts';
import type { FetchLike, HostAdmin } from '@substrat-run/kernel';

/** One gateway group of one day: what the gateway saw for one (attribution, provider, model). */
export interface GatewayModelGroup {
  /** The `tenant` metadata key; null when the request carried none. */
  tenant: string | null;
  scope: string | null;
  /** The `vertical` metadata key: the vertical's package name, as the model host sends it. */
  vertical: string | null;
  /** Cloudflare's provider slug (`workers-ai`), not the platform's provider row. */
  provider: string;
  modelId: string;
  /** Requests that succeeded. Errored ones are left out: they produced no answer and no line. */
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: string;
}

/** One Workers AI group of one day, by model and the route the call came in on. */
export interface WorkersAiGroup {
  modelId: string;
  /** Cloudflare's `requestSource`: `aig binding` for a call through a gateway, `unknown` for one that bypassed it. */
  requestSource: string;
  calls: number;
  neurons: string;
}

export interface ModelCostDay {
  gateway: readonly GatewayModelGroup[];
  workersAi: readonly WorkersAiGroup[];
}

/** Reads what Cloudflare saw on one UTC day. Throws rather than answer with part of it. */
export interface ModelCostReader {
  readDay(day: string): Promise<ModelCostDay>;
}

/**
 * Workers AI's list price: $0.011 per 1,000 neurons (developers.cloudflare.com/workers-ai/platform/pricing),
 * before the account's daily free allocation. An estimate of what an unattributed call cost, never a bill.
 */
export const WORKERS_AI_USD_PER_NEURON = '0.000011';

/** A cost difference smaller than this is rounding between two price lists, not a finding. */
export const COST_TOLERANCE_USD = '0.01';
/** Nor one within this share of the larger side. Cloudflare's cost is an estimate; our rate card is another. */
export const COST_TOLERANCE_PERCENT = 10;

/** Whether a Workers AI `requestSource` names a call that passed through a gateway (`aig binding`, `aig rest`, …). */
export const viaGateway = (requestSource: string): boolean => /(^|\s)aig(\s|$)/.test(requestSource);

const subtract = (a: string, b: string): string => addDecimal(a, b.startsWith('-') ? b.slice(1) : b === '0' ? '0' : `-${b}`);
const abs = (a: string): string => (a.startsWith('-') ? a.slice(1) : a);
const max = (a: string, b: string): string => (compareDecimal(a, b) >= 0 ? a : b);

/** Whether two costs differ beyond tolerance: more than `COST_TOLERANCE_USD` AND more than `COST_TOLERANCE_PERCENT` of the larger. */
export function costsDiffer(ledgerUsd: string, gatewayUsd: string): boolean {
  const delta = abs(subtract(gatewayUsd, ledgerUsd));
  if (compareDecimal(delta, COST_TOLERANCE_USD) <= 0) return false;
  const share = mulDecimal(max(ledgerUsd, gatewayUsd), String(COST_TOLERANCE_PERCENT / 100));
  return compareDecimal(delta, share) > 0;
}

export interface ReconcileDayInput {
  day: string;
  readAt: string;
  /** Every ledger line whose `at` falls on the day. */
  ledger: readonly ModelUsageEntry[];
  cost: ModelCostDay;
  /**
   * The platform's provider rows whose calls are sent through AI Gateway (the `cloudflare` row).
   * A line for any other provider never passed a gateway, so it has nothing to be reconciled with.
   */
  gatewayProviders: readonly string[];
  /**
   * The tenants this directory holds, of those the gateway names. A group for any other tenant is
   * another environment's (they share the account) and is set aside. Absent: every tenant counts.
   */
  heldTenants?: ReadonlySet<string>;
}

/**
 * One day, folded. Joined on (tenant, scope, model id): the vertical cannot be the key, because a
 * drained line is filed under the scope's slug while the gateway carries the package name.
 *
 * A ledger line is one model-host RUN, and a run with tools makes up to eight model calls, each
 * retried by the SDK on a transient failure, so the gateway seeing MORE requests than the ledger
 * has lines is expected. Fewer successful requests than lines is not: every line had at least one.
 */
export function reconcileModelDay(input: ReconcileDayInput): ModelReconciliationDay {
  const routed = new Set(input.gatewayProviders);
  type Side = ModelReconciliationRow['ledger'];
  type Gate = ModelReconciliationRow['gateway'];
  const rows = new Map<string, { tenantId: string; scopeId: string; modelId: string; vertical: string | null; ledger: Side; gateway: Gate }>();
  const keyOf = (tenant: string, scope: string, modelId: string) => JSON.stringify([tenant, scope, modelId]);
  const rowFor = (tenantId: string, scopeId: string, modelId: string) => {
    const key = keyOf(tenantId, scopeId, modelId);
    let row = rows.get(key);
    if (!row) {
      row = {
        tenantId,
        scopeId,
        modelId,
        vertical: null,
        ledger: { calls: 0, inputTokens: 0, outputTokens: 0, listUsd: '0', unpriced: 0 },
        gateway: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: '0' },
      };
      rows.set(key, row);
    }
    return row;
  };

  let offGatewayLedgerCalls = 0;
  let ledgerListUsd = '0';
  for (const line of input.ledger) {
    if (!routed.has(line.provider)) {
      offGatewayLedgerCalls += 1;
      continue;
    }
    const row = rowFor(line.attribution.tenant, line.attribution.scope, line.modelId);
    row.vertical = line.attribution.vertical;
    row.ledger.calls += 1;
    row.ledger.inputTokens += line.inputTokens;
    row.ledger.outputTokens += line.outputTokens;
    if (line.listUsd === null) row.ledger.unpriced += 1;
    else {
      row.ledger.listUsd = addDecimal(row.ledger.listUsd, line.listUsd);
      ledgerListUsd = addDecimal(ledgerListUsd, line.listUsd);
    }
  }

  const unattributed = new Map<string, ModelReconciliationDay['unattributedGateway'][number]>();
  let gatewayCostUsd = '0';
  const otherDirectoryGateway = { calls: 0, costUsd: '0' };
  for (const g of input.cost.gateway) {
    if (g.tenant && input.heldTenants && !input.heldTenants.has(g.tenant)) {
      otherDirectoryGateway.calls += g.calls;
      otherDirectoryGateway.costUsd = addDecimal(otherDirectoryGateway.costUsd, g.costUsd);
      continue;
    }
    gatewayCostUsd = addDecimal(gatewayCostUsd, g.costUsd);
    if (!g.tenant || !g.scope) {
      const key = JSON.stringify([g.provider, g.modelId]);
      const u = unattributed.get(key) ?? { provider: g.provider, modelId: g.modelId, calls: 0, costUsd: '0' };
      u.calls += g.calls;
      u.costUsd = addDecimal(u.costUsd, g.costUsd);
      unattributed.set(key, u);
      continue;
    }
    const row = rowFor(g.tenant, g.scope, g.modelId);
    // The ledger's vertical wins when there is one: it is the slug the directory knows the scope by.
    row.vertical ??= g.vertical;
    row.gateway.calls += g.calls;
    row.gateway.inputTokens += g.inputTokens;
    row.gateway.outputTokens += g.outputTokens;
    row.gateway.costUsd = addDecimal(row.gateway.costUsd, g.costUsd);
  }

  const out: ModelReconciliationRow[] = [];
  for (const r of rows.values()) {
    // A group whose every request errored is no call at all, on either side.
    if (r.ledger.calls === 0 && r.gateway.calls === 0) continue;
    const differs: ModelReconciliationRow['differs'] = [];
    let status: ModelReconciliationRow['status'];
    if (r.gateway.calls === 0) status = 'ledger-only';
    else if (r.ledger.calls === 0) status = 'gateway-only';
    else {
      if (r.gateway.calls < r.ledger.calls) differs.push('calls');
      // An unpriced line has no list price to compare: only a fully priced row is judged on cost.
      if (r.ledger.unpriced === 0 && costsDiffer(r.ledger.listUsd, r.gateway.costUsd)) differs.push('cost');
      status = differs.length ? 'discrepancy' : 'matched';
    }
    out.push({ ...r, status, differs, deltaUsd: subtract(r.gateway.costUsd, r.ledger.listUsd) });
  }
  out.sort((a, b) => a.tenantId.localeCompare(b.tenantId) || a.scopeId.localeCompare(b.scopeId) || a.modelId.localeCompare(b.modelId));

  const bypass = new Map<string, ModelReconciliationDay['workersAiWithoutGateway'][number]>();
  let workersAiWithoutGatewayUsd = '0';
  for (const w of input.cost.workersAi) {
    if (viaGateway(w.requestSource)) continue;
    const key = JSON.stringify([w.modelId, w.requestSource]);
    const b = bypass.get(key) ?? { modelId: w.modelId, requestSource: w.requestSource, calls: 0, neurons: '0', estimatedUsd: '0' };
    b.calls += w.calls;
    b.neurons = addDecimal(b.neurons, w.neurons);
    b.estimatedUsd = mulDecimal(b.neurons, WORKERS_AI_USD_PER_NEURON);
    bypass.set(key, b);
  }
  for (const b of bypass.values()) workersAiWithoutGatewayUsd = addDecimal(workersAiWithoutGatewayUsd, b.estimatedUsd);

  return modelReconciliationDay.parse({
    day: input.day,
    readAt: input.readAt,
    rows: out,
    unattributedGateway: [...unattributed.values()],
    workersAiWithoutGateway: [...bypass.values()],
    otherDirectoryGateway,
    offGatewayLedgerCalls,
    totals: { ledgerListUsd, gatewayCostUsd, workersAiWithoutGatewayUsd },
  });
}

/** The most ledger lines one day may hold before the read refuses rather than reconcile part of it. */
export const LEDGER_LINES_PER_DAY_MAX = 50_000;
const LEDGER_PAGE = 1_000;

/** The `[since, until)` of a UTC day. */
export function dayBounds(day: string): { since: string; until: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00.000Z`))) {
    throw new RangeError(`not a UTC day: ${day}`);
  }
  const since = `${day}T00:00:00.000Z`;
  return { since, until: new Date(Date.parse(since) + 86_400_000).toISOString() };
}

/** Every ledger line of one UTC day, oldest first. Refuses a day larger than `LEDGER_LINES_PER_DAY_MAX`. */
export async function ledgerLinesOf(
  admin: Pick<HostAdmin, 'listModelUsage'>,
  actor: PlatformActorId,
  day: string,
): Promise<ModelUsageEntry[]> {
  const { since, until } = dayBounds(day);
  const lines: ModelUsageEntry[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await admin.listModelUsage(actor, { since, until, order: 'asc', limit: LEDGER_PAGE, ...(cursor ? { cursor } : {}) });
    lines.push(...page);
    if (lines.length > LEDGER_LINES_PER_DAY_MAX) {
      throw new RangeError(`${day} holds more than ${LEDGER_LINES_PER_DAY_MAX} model usage lines; reconcile refuses part of a day`);
    }
    if (page.length < LEDGER_PAGE) return lines;
    cursor = page[page.length - 1]!.id;
  }
}

export interface ReconcileDeps {
  admin: Pick<HostAdmin, 'listModelUsage' | 'getTenant'>;
  actor: PlatformActorId;
  reader: ModelCostReader;
  gatewayProviders: readonly string[];
  now?: () => Date;
}

/** Reconcile each of the given UTC days, one after another (each is one ledger walk and one GraphQL read). */
export async function reconcileModelDays(deps: ReconcileDeps, days: readonly string[]): Promise<ModelReconciliationDay[]> {
  const now = deps.now ?? (() => new Date());
  const out: ModelReconciliationDay[] = [];
  for (const day of days) {
    const [ledger, cost] = await Promise.all([ledgerLinesOf(deps.admin, deps.actor, day), deps.reader.readDay(day)]);
    const heldTenants = await heldTenantsOf(deps, cost.gateway);
    out.push(reconcileModelDay({ day, readAt: now().toISOString(), ledger, cost, gatewayProviders: deps.gatewayProviders, heldTenants }));
  }
  return out;
}

/** Which of the tenants the gateway names this directory holds: one directory read per distinct tenant. */
async function heldTenantsOf(deps: ReconcileDeps, groups: readonly GatewayModelGroup[]): Promise<Set<string>> {
  const held = new Set<string>();
  for (const id of new Set(groups.flatMap((g) => (g.tenant ? [g.tenant] : [])))) {
    // A metadata value is the caller's text: only a well-formed tenant id is looked up.
    const parsed = tenantId.safeParse(id);
    if (parsed.success && (await deps.admin.getTenant(deps.actor, parsed.data))) held.add(id);
  }
  return held;
}

/** The UTC days from `since` to `until`, both included. */
export function daysBetween(since: string, until: string): string[] {
  const days: string[] = [];
  for (let t = Date.parse(dayBounds(since).since); t <= Date.parse(dayBounds(until).since); t += 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

// -- the scheduled half -------------------------------------------------------------------------

/** How many closed days back the pass looks for one it has not reconciled. Inside sweep-run retention (14 days). */
export const MODEL_RECONCILE_LOOKBACK_DAYS = 7;
/** The most days one pass reconciles; a first pass after deploy catches up over several. */
export const MODEL_RECONCILE_DAYS_PER_PASS = 2;
/**
 * How long after a day ends it is reconciled. Lines reach the ledger through the platform-intent
 * drain, which runs every fifteen minutes, and gateway analytics land within minutes.
 */
export const MODEL_RECONCILE_SETTLE_MS = 2 * 3_600_000;
/** How long a day whose reconciliation failed waits before it is tried again. */
export const MODEL_RECONCILE_RETRY_MS = 3_600_000;

/** The ops-failure `operation` a finding is filed under. */
export const MODEL_RECONCILE_OPERATION = 'sweep.model-reconcile';

export interface ModelReconcilePassDeps extends ReconcileDeps {
  admin: Pick<HostAdmin, 'listModelUsage' | 'getTenant' | 'listSweepRuns' | 'recordSweepRun' | 'recordOpsFailure'>;
  lookbackDays?: number;
  daysPerPass?: number;
}

export interface ModelReconcilePassReport {
  reconciled: Array<{ day: string; matched: number; discrepancy: number; ledgerOnly: number; gatewayOnly: number; workersAiWithoutGatewayUsd: string }>;
  failed: Array<{ day: string; error: string }>;
}

/** The closed UTC days the pass may reconcile now, oldest first. */
export function reconcilableDays(now: Date, lookbackDays: number): string[] {
  const days: string[] = [];
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  for (let back = lookbackDays; back >= 1; back--) {
    const start = today - back * 86_400_000;
    if (start + 86_400_000 + MODEL_RECONCILE_SETTLE_MS <= now.getTime()) days.push(new Date(start).toISOString().slice(0, 10));
  }
  return days;
}

/**
 * One scheduled pass: the closed days with no `ok` reconciliation row yet, oldest first, up to
 * `daysPerPass`. Each day's findings are filed as staff ops-failure rows, then the day's `ok` row is
 * written, which is what keeps a later pass from filing them again. A day that fails gets a `failed`
 * row and is tried again after `MODEL_RECONCILE_RETRY_MS`.
 *
 * Filed: every `gateway-only` row (the self-report gap), every `discrepancy`, and the day's Workers AI
 * calls that bypassed any gateway, when there were some. A `ledger-only` row is not filed: a model
 * host running through the Workers AI binding makes one by design today (#3320), and it is in the route.
 *
 * Every row is filed with NO tenant: a row under a tenant is readable by that tenant (#2540), and
 * what these say is the platform's to act on.
 */
export async function runModelReconciliationPass(deps: ModelReconcilePassDeps): Promise<ModelReconcilePassReport> {
  const now = (deps.now ?? (() => new Date()))();
  const report: ModelReconcilePassReport = { reconciled: [], failed: [] };
  const candidates = reconcilableDays(now, deps.lookbackDays ?? MODEL_RECONCILE_LOOKBACK_DAYS);
  if (candidates.length === 0) return report;
  const runs = await deps.admin.listSweepRuns(deps.actor, {
    kind: 'model-reconcile',
    since: dayBounds(candidates[0]!).since,
    order: 'desc',
    limit: 200,
  });
  const latest = new Map<string, (typeof runs)[number]>();
  for (const r of runs) if (!latest.has(r.unit)) latest.set(r.unit, r);
  const due = candidates.filter((day) => {
    const last = latest.get(day);
    if (!last) return true;
    if (last.outcome === 'ok') return false;
    return Date.parse(last.at) + MODEL_RECONCILE_RETRY_MS <= now.getTime();
  });

  for (const day of due.slice(0, deps.daysPerPass ?? MODEL_RECONCILE_DAYS_PER_PASS)) {
    const started = Date.now();
    try {
      const [result] = await reconcileModelDays({ ...deps, now: () => now }, [day]);
      await fileFindings(deps, result!);
      await deps.admin.recordSweepRun({ kind: 'model-reconcile', unit: day, outcome: 'ok', elapsedMs: Date.now() - started });
      const count = (s: ModelReconciliationRow['status']) => result!.rows.filter((r) => r.status === s).length;
      report.reconciled.push({
        day,
        matched: count('matched'),
        discrepancy: count('discrepancy'),
        ledgerOnly: count('ledger-only'),
        gatewayOnly: count('gateway-only'),
        workersAiWithoutGatewayUsd: result!.totals.workersAiWithoutGatewayUsd,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      report.failed.push({ day, error });
      await deps.admin
        .recordSweepRun({ kind: 'model-reconcile', unit: day, outcome: 'failed', error, elapsedMs: Date.now() - started })
        .catch(() => undefined);
    }
  }
  return report;
}

async function fileFindings(deps: ModelReconcilePassDeps, day: ModelReconciliationDay): Promise<void> {
  const file = (entry: { stage: string; scopeId: string | null; vertical: string | null; message: string }) =>
    deps.admin.recordOpsFailure({
      actor: deps.actor,
      operation: MODEL_RECONCILE_OPERATION,
      stage: entry.stage,
      tenantId: null,
      scopeId: entry.scopeId as ScopeId | null,
      vertical: entry.vertical,
      message: entry.message,
    });
  for (const r of day.rows) {
    if (r.status === 'gateway-only') {
      await file({
        stage: 'gateway-only',
        scopeId: r.scopeId,
        vertical: r.vertical,
        message:
          `${day.day}: ${r.gateway.calls} ${r.modelId} request(s) for tenant ${r.tenantId} reached AI Gateway under this scope ` +
          `($${r.gateway.costUsd} at the gateway's estimate) and no model usage line accounts for them: ` +
          'the model host did not raise a model-usage intent, so these calls are metered nowhere',
      });
    } else if (r.status === 'discrepancy') {
      await file({
        stage: 'discrepancy',
        scopeId: r.scopeId,
        vertical: r.vertical,
        message:
          `${day.day}: ${r.modelId} for tenant ${r.tenantId} differs in ${r.differs.join(' and ')}: ` +
          `ledger ${r.ledger.calls} line(s) at $${r.ledger.listUsd} list, gateway ${r.gateway.calls} request(s) at $${r.gateway.costUsd}`,
      });
    }
  }
  if (compareDecimal(day.totals.workersAiWithoutGatewayUsd, '0') > 0) {
    const calls = day.workersAiWithoutGateway.reduce((n, w) => n + w.calls, 0);
    await file({
      stage: 'without-gateway',
      scopeId: null,
      vertical: null,
      message:
        `${day.day}: ${calls} Workers AI request(s), about $${day.totals.workersAiWithoutGatewayUsd} at list price, ` +
        'went through no AI Gateway, so nothing attributes them to a tenant; only a ledger line raised by their model host can',
    });
  }
}

// -- Cloudflare's GraphQL Analytics ---------------------------------------------------------------

/** The row ceiling of one adaptive-groups answer. A day that reaches it is refused, never truncated. */
export const MODEL_COST_ROW_LIMIT = 10_000;

const MODEL_COST_QUERY = `
  query ModelCostDay($accountTag: String!, $start: Time!, $end: Time!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        gateway: aiGatewayRequestsAdaptiveGroups(
          limit: ${MODEL_COST_ROW_LIMIT}
          filter: { datetime_geq: $start, datetime_lt: $end }
        ) {
          count
          sum { cost tokensIn tokensOut erroredRequests }
          dimensions {
            provider
            model
            tenant: metadataValue(key: "tenant")
            scope: metadataValue(key: "scope")
            vertical: metadataValue(key: "vertical")
          }
        }
        workersAi: aiInferenceAdaptiveGroups(
          limit: ${MODEL_COST_ROW_LIMIT}
          filter: { datetime_geq: $start, datetime_lt: $end }
        ) {
          count
          sum { totalNeurons }
          dimensions { modelId requestSource }
        }
      }
    }
  }
`;

export interface CfModelCostReaderOptions {
  accountId: string;
  /** Needs Account Analytics Read. */
  apiToken: string;
  /** `globalFetch` from `@substrat-run/kernel` in a worker; a stub in a test. */
  fetch: FetchLike;
}

interface GatewayWire {
  count: number;
  sum: { cost: number | null; tokensIn: number | null; tokensOut: number | null; erroredRequests: number | null };
  dimensions: { provider: string; model: string; tenant: string; scope: string; vertical: string };
}
interface WorkersAiWire {
  count: number;
  sum: { totalNeurons: number | null };
  dimensions: { modelId: string; requestSource: string };
}

/** A float from the analytics API as the 6-dp decimal string money is kept in. The boundary is the one place a float is read. */
const decimalOf = (n: number | null | undefined): string => {
  const v = typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
  return v.toFixed(6).replace(/\.?0+$/, '') || '0';
};

export function createCfModelCostReader(opts: CfModelCostReaderOptions): ModelCostReader {
  return {
    async readDay(day) {
      const { since, until } = dayBounds(day);
      const res = await opts.fetch('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST',
        headers: { authorization: `Bearer ${opts.apiToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query: MODEL_COST_QUERY, variables: { accountTag: opts.accountId, start: since, end: until } }),
      });
      if (!res.ok) throw new Error(`Cloudflare analytics answered ${res.status} for ${day}`);
      const body = (await res.json()) as {
        data?: { viewer?: { accounts?: Array<{ gateway?: GatewayWire[]; workersAi?: WorkersAiWire[] }> } } | null;
        errors?: Array<{ message?: string }> | null;
      };
      if (body.errors?.length) throw new Error(`Cloudflare analytics refused ${day}: ${body.errors.map((e) => e.message).join('; ')}`);
      const account = body.data?.viewer?.accounts?.[0];
      if (!account) throw new Error(`Cloudflare analytics returned no account for ${day}`);
      const gateway = account.gateway ?? [];
      const workersAi = account.workersAi ?? [];
      if (gateway.length >= MODEL_COST_ROW_LIMIT || workersAi.length >= MODEL_COST_ROW_LIMIT) {
        throw new RangeError(`${day} holds ${MODEL_COST_ROW_LIMIT} or more model cost groups; reconcile refuses part of a day`);
      }
      return {
        gateway: gateway.map((g) => ({
          tenant: g.dimensions.tenant || null,
          scope: g.dimensions.scope || null,
          vertical: g.dimensions.vertical || null,
          provider: g.dimensions.provider,
          modelId: g.dimensions.model,
          calls: Math.max(0, g.count - (g.sum.erroredRequests ?? 0)),
          inputTokens: g.sum.tokensIn ?? 0,
          outputTokens: g.sum.tokensOut ?? 0,
          costUsd: decimalOf(g.sum.cost),
        })),
        workersAi: workersAi.map((w) => ({
          modelId: w.dimensions.modelId,
          requestSource: w.dimensions.requestSource,
          calls: w.count,
          neurons: decimalOf(w.sum.totalNeurons),
        })),
      };
    },
  };
}
