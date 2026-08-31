/**
 * Studio usage metering — the builder's first kernel-backed table (#646).
 *
 * The studio is staff-only and has no customer tenant to bill, so the usage
 * ledger lives in the builder's OWN scope: a CP-less kernel host (the
 * sandbox-clean vertical shape — `CloudflareScopeHost` with no control plane,
 * provisioned via `provisionScopeLocal`) whose ScopeDO bundles exactly one
 * module, the metering engine. This is deliberately the first brick of the
 * builder's record-keeping half becoming a vertical (D-31/D-33): when builder
 * teams arrive, recording moves to per-team scopes and this fixed node retires.
 *
 * One fixed node, Meridian-DEV_NODE-style constants: a single studio scope,
 * entries attributed per project via `subject` and per turn via the dedupe key.
 * Recording is BEST-EFFORT by design — the turn's value is the commit, and a
 * metering outage must never fail the turn; a miss is logged, and the dedupe
 * key makes any retry safe.
 */
import {
	addDecimal,
	LIST_PAGE_MAX,
	permissionKey,
	principalId,
	scopeId,
	tenantId,
	type Page,
} from '@substrat-run/contracts';
import { CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import { meteringModule, PERM as METERING_PERM } from '@substrat-run/engine-metering';
import {
	MARKUP_PERCENT,
	costOf,
	costOfSteps,
	normalizeModelSpec,
	withMarkup,
	type StepTokens,
} from './pricing.js';

/** The studio's fixed node — valid ULIDs, same shape as Meridian's DEV_NODE. */
export const STUDIO_NODE = {
	tenantId: tenantId.parse('01JZ0000000000000000STD001'),
	scopeId: scopeId.parse('01JZ0000000000000000STD002'),
};

/**
 * The recording principal. Entries carry it as `created_by`; the human staff
 * actor is not threaded through v0 (the studio DO is one shared instance), so
 * per-person attribution is deliberately absent rather than pretended.
 */
const STUDIO_RECORDER = principalId.parse('01JZ0000000000000000STD003');

const STUDIO_ROLE = 'studio-metering';

/**
 * Meter keys carry the MODEL as the billing dimension (engine-metering:
 * "subject ≠ meter dimension" — anything that changes the price must be part
 * of the key, so each model aggregates to its own period line and the rate
 * card in pricing.ts can price it). `<model>` is the normalized
 * `provider:modelId`. The pre-model keys (`ai.tokens.input`/`.output`, #646
 * v0) still exist in the ledger; reads fold them in as unattributed.
 */
const SIDES = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
type Side = (typeof SIDES)[number];

const meterKey = (side: Side, model: string): string => `ai.tokens.${side}.${model}`;

/**
 * The turn's provider LIST cost in USD, computed at RECORD time from the
 * per-step usage — the only place tier selection can be done correctly
 * (pricing.ts: all-or-nothing per request). Stored as a decimal-string
 * counter; the markup is presentation policy, applied at read.
 */
const costKey = (model: string): string => `ai.cost.usd.${model}`;

/** null = not a token meter; model null = a pre-model v0 key. */
function parseMeterKey(key: string): { side: Side; model: string | null } | null {
	for (const side of SIDES) {
		const flat = `ai.tokens.${side}`;
		if (key === flat) return { side, model: null };
		if (key.startsWith(`${flat}.`)) return { side, model: key.slice(flat.length + 1) };
	}
	return null;
}

/** The model of a cost meter, or null for any other key. */
function parseCostKey(key: string): string | null {
	return key.startsWith('ai.cost.usd.') ? key.slice('ai.cost.usd.'.length) : null;
}

export interface StudioEnv {
	SCOPE: DurableObjectNamespace;
}

function hostFor(env: StudioEnv): CloudflareScopeHost {
	const host = new CloudflareScopeHost({ scope: env.SCOPE });
	host.registerModule(meteringModule);
	return host;
}

/**
 * Provision-or-heal, memoized per isolate. `provisionScopeLocal` is idempotent
 * (migrations no-op once applied; the projection rewrites the same rows), so a
 * cold start re-running it is a self-heal, not a hazard. Entitlements are
 * deliberately omitted: an un-projected scope trusts upstream (#304), which is
 * the truthful state — the studio has no plan.
 */
let ready: Promise<void> | null = null;

function ensureStudio(env: StudioEnv): Promise<void> {
	ready ??= (async () => {
		const host = hostFor(env);
		await host.provisionScopeLocal({
			tenantId: STUDIO_NODE.tenantId,
			scopeId: STUDIO_NODE.scopeId,
			owner: STUDIO_RECORDER,
			roles: [
				{
					key: STUDIO_ROLE,
					permissions: [
						METERING_PERM.read,
						METERING_PERM.record,
						METERING_PERM.configure,
						METERING_PERM.close,
					].map((p) => permissionKey.parse(p)),
					source: 'vertical',
				},
			],
			ownerRoleKey: STUDIO_ROLE,
		});
		// Meters are per-model and configured lazily by recordTurnUsage — a new
		// model id must never require a deploy to start metering.
	})().catch((err) => {
		ready = null; // a failed bootstrap must not poison every later turn
		throw err;
	});
	return ready;
}

export interface TurnUsage {
	readonly projectId: string;
	/** The turn's ulid — the dedupe key, so a replayed report can never double-bill. */
	readonly turnId: string;
	/** The turn's model spec (`qwen:qwen3.8-max`, `claude-opus-5`, …) — normalized here. */
	readonly model: string;
	readonly inputTokens: number;
	readonly outputTokens: number;
	/** Turn totals; absent = the provider reported nothing, never zero. */
	readonly cachedInputTokens?: number;
	readonly cacheWriteTokens?: number;
	/**
	 * Per-request breakdown from the generator's usage event. When present,
	 * cost is priced per step (tier selection is per request); when absent the
	 * turn totals price as one pseudo-request — exact for single-tier cards.
	 */
	readonly stepUsage?: readonly StepTokens[];
}

/**
 * Record one turn's token usage — two counter entries under one dedupe key
 * (per-meter uniqueness is the engine's design). Throws on failure; use
 * `reportTurnUsage` from the turn path.
 */
export async function recordTurnUsage(env: StudioEnv, usage: TurnUsage): Promise<void> {
	await ensureStudio(env);
	const scope = await hostFor(env).getScope(
		STUDIO_RECORDER,
		STUDIO_NODE.tenantId,
		STUDIO_NODE.scopeId,
	);
	const model = normalizeModelSpec(usage.model);
	const subject = { entityType: 'builder-project', entityId: usage.projectId };
	const sides: Array<[Side, number | undefined]> = [
		['input', usage.inputTokens],
		['output', usage.outputTokens],
		// Cache sides only when measured — absence means "not reported", and a
		// recorded 0 would falsely claim the turn ran cache-cold.
		['cacheRead', usage.cachedInputTokens],
		['cacheWrite', usage.cacheWriteTokens],
	];
	for (const [side, qty] of sides) {
		if (qty === undefined && side !== 'input' && side !== 'output') continue;
		const meter = meterKey(side, model);
		// configureMeter is an idempotent upsert; kind/unit are identical for
		// every token meter, so re-configuring an existing key is a no-op.
		await scope.invoke('metering/configure-meter', { key: meter, kind: 'counter', unit: 'tokens' });
		await scope.invoke('metering/record', {
			meter,
			qty: String(qty ?? 0),
			subject,
			dedupeKey: usage.turnId,
		});
	}

	// Cost is priced HERE, where the per-step split still exists — the ledger's
	// token sums cannot be tier-priced after aggregation (pricing.ts header).
	// An unpriced model records no cost entry: the read side reports its tokens
	// as unpriced, never a guessed $0.
	const steps: readonly StepTokens[] = usage.stepUsage?.length
		? usage.stepUsage
		: [
				{
					inputTokens: usage.inputTokens,
					outputTokens: usage.outputTokens,
					...(usage.cachedInputTokens != null
						? { cachedInputTokens: usage.cachedInputTokens }
						: {}),
					...(usage.cacheWriteTokens != null ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
				},
			];
	const cost = costOfSteps(model, steps);
	if (cost) {
		const meter = costKey(model);
		await scope.invoke('metering/configure-meter', { key: meter, kind: 'counter', unit: 'usd' });
		await scope.invoke('metering/record', {
			meter,
			qty: cost.listUsd,
			subject,
			dedupeKey: usage.turnId,
		});
	}
}

/**
 * The turn-path wrapper: best-effort, never throws. The turn's product is the
 * commit; the meter must not be able to take it down. A miss is visible in the
 * worker log, and the per-turn dedupe key makes the next attempt safe.
 */
export async function reportTurnUsage(env: StudioEnv, usage: TurnUsage): Promise<void> {
	try {
		await recordTurnUsage(env, usage);
	} catch (err) {
		console.error(
			`metering: failed to record turn ${usage.turnId} (project ${usage.projectId}): ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
}

// ── the read side: /api/usage (#655) ──────────────────────────────────────────

interface EntryView {
	meterKey: string;
	qty: string;
	subject: { entityType: string; entityId: string } | null;
	occurredAt: string;
}

export interface UsageDay {
	/** YYYY-MM-DD (UTC). */
	date: string;
	input: number;
	output: number;
}

export interface UsageByProject {
	projectId: string;
	input: number;
	output: number;
	turns: number;
}

export interface UsageByModel {
	/** Normalized `provider:modelId`; null for pre-model v0 entries. */
	model: string | null;
	input: number;
	output: number;
	/** Cache slices of `input`, when the provider reported them (0 otherwise). */
	cacheRead: number;
	cacheWrite: number;
	/** Provider list price in USD; null when the model has no rate card entry. */
	listUsd: string | null;
	/** What the studio charges: list + 20% markup; null when unpriced. */
	billedUsd: string | null;
}

export interface UsageReport {
	totals: { input: number; output: number };
	/** Oldest-first, one row per UTC day with any usage, capped to the window. */
	daily: UsageDay[];
	/** Largest spend first. */
	byProject: UsageByProject[];
	/** Largest spend first. All-time, priced by the rate card (pricing.ts). */
	byModel: UsageByModel[];
	/** Sums over the PRICED rows only; unpricedTokens is the honest remainder. */
	cost: { listUsd: string; billedUsd: string; unpricedTokens: number };
	markupPercent: number;
	windowDays: number;
	generatedAt: string;
}

/**
 * The studio's usage, aggregated for the Usage pane. Reads the ledger via the
 * engine's registered operations and rolls up host-side (this is harness code,
 * not module code — plain JS over the returned rows is fine). Token counts are
 * integers well under 2^53, so Number() is exact here; the engine's decimal
 * discipline still guards the stored truth.
 */
export async function studioUsage(env: StudioEnv, windowDays = 30): Promise<UsageReport> {
	await ensureStudio(env);
	const scope = await hostFor(env).getScope(
		STUDIO_RECORDER,
		STUDIO_NODE.tenantId,
		STUDIO_NODE.scopeId,
	);
	// The ledger read is PAGED (#959), and this report is a fold over all of it:
	// `totals` and `byModel` are lifetime figures, not windowed ones, so taking
	// the first page would quietly under-report every number on the usage screen.
	// Harness code, so the walk is a plain loop over the cursor.
	const entries: EntryView[] = [];
	for (let cursor: string | null = null; ; ) {
		const page = (await scope.invoke('metering/list-entries', {
			limit: LIST_PAGE_MAX,
			...(cursor === null ? {} : { cursor }),
		})) as Page<EntryView>;
		entries.push(...page.entries);
		if (page.nextCursor === null) break;
		cursor = page.nextCursor;
	}

	const totals = { input: 0, output: 0 };
	const byDay = new Map<string, UsageDay>();
	const byProject = new Map<string, UsageByProject>();
	const byModel = new Map<
		string | null,
		{ model: string | null; input: number; output: number; cacheRead: number; cacheWrite: number }
	>();
	/** Model → summed record-time list cost. Only models with cost entries. */
	const costByModel = new Map<string, string>();
	const windowStart = new Date(Date.now() - windowDays * 86_400_000).toISOString();

	const modelRow = (model: string | null) => {
		const row = byModel.get(model) ?? { model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		byModel.set(model, row);
		return row;
	};

	for (const e of entries) {
		const costModel = parseCostKey(e.meterKey);
		if (costModel !== null) {
			costByModel.set(costModel, addDecimal(costByModel.get(costModel) ?? '0', e.qty));
			continue;
		}
		const parsed = parseMeterKey(e.meterKey);
		if (!parsed) continue;
		const { side, model } = parsed;
		const qty = Number(e.qty);
		modelRow(model)[side] += qty;
		// Cache sides are slices OF input, already counted there — they roll up
		// per model only; adding them to totals/daily/projects would double-count.
		if (side !== 'input' && side !== 'output') continue;
		totals[side] += qty;

		if (e.occurredAt >= windowStart) {
			const date = e.occurredAt.slice(0, 10);
			const day = byDay.get(date) ?? { date, input: 0, output: 0 };
			day[side] += qty;
			byDay.set(date, day);
		}

		const projectId = e.subject?.entityType === 'builder-project' ? e.subject.entityId : '(none)';
		const proj = byProject.get(projectId) ?? { projectId, input: 0, output: 0, turns: 0 };
		proj[side] += qty;
		// Each turn records both meters under one dedupe key — count it once.
		if (side === 'input') proj.turns += 1;
		byProject.set(projectId, proj);
	}

	// Price each model row: prefer the record-time cost entries (per-step tier
	// and cache pricing, #663); fall back to flat totals pricing only for rows
	// recorded before cost meters existed. Totals only ever sum PRICED rows —
	// an unpriced model shows as tokens, never as a guessed $0.
	const cost = { listUsd: '0', billedUsd: '0', unpricedTokens: 0 };
	const modelRows = [...byModel.values()].map((m): UsageByModel => {
		const recorded = m.model === null ? undefined : costByModel.get(m.model);
		const priced =
			recorded !== undefined
				? { listUsd: recorded, billedUsd: withMarkup(recorded) }
				: m.model === null
					? null
					: costOf(m.model, m.input, m.output);
		if (priced) {
			cost.listUsd = addDecimal(cost.listUsd, priced.listUsd);
			cost.billedUsd = addDecimal(cost.billedUsd, priced.billedUsd);
		} else {
			cost.unpricedTokens += m.input + m.output;
		}
		return { ...m, listUsd: priced?.listUsd ?? null, billedUsd: priced?.billedUsd ?? null };
	});

	return {
		totals,
		daily: [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
		byProject: [...byProject.values()].sort((a, b) => b.input + b.output - (a.input + a.output)),
		byModel: modelRows.sort((a, b) => b.input + b.output - (a.input + a.output)),
		cost,
		markupPercent: MARKUP_PERCENT,
		windowDays,
		generatedAt: new Date().toISOString(),
	};
}
