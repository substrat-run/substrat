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
import { permissionKey, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import { meteringModule, PERM as METERING_PERM } from '@substrat-run/engine-metering';

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

/** The two turn meters. Registered idempotently on every provision. */
export const METERS = {
	input: 'ai.tokens.input',
	output: 'ai.tokens.output',
} as const;

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
		const scope = await host.getScope(STUDIO_RECORDER, STUDIO_NODE.tenantId, STUDIO_NODE.scopeId);
		for (const key of [METERS.input, METERS.output]) {
			await scope.invoke('metering/configure-meter', { key, kind: 'counter', unit: 'tokens' });
		}
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
	readonly inputTokens: number;
	readonly outputTokens: number;
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
	const subject = { entityType: 'builder-project', entityId: usage.projectId };
	for (const [meter, qty] of [
		[METERS.input, usage.inputTokens],
		[METERS.output, usage.outputTokens],
	] as const) {
		await scope.invoke('metering/record', {
			meter,
			qty: String(qty),
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

export interface UsageReport {
	totals: { input: number; output: number };
	/** Oldest-first, one row per UTC day with any usage, capped to the window. */
	daily: UsageDay[];
	/** Largest spend first. */
	byProject: UsageByProject[];
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
	const entries = (await scope.invoke('metering/list-entries', undefined)) as EntryView[];

	const totals = { input: 0, output: 0 };
	const byDay = new Map<string, UsageDay>();
	const byProject = new Map<string, UsageByProject>();
	const windowStart = new Date(Date.now() - windowDays * 86_400_000).toISOString();

	for (const e of entries) {
		const side =
			e.meterKey === METERS.input ? 'input' : e.meterKey === METERS.output ? 'output' : null;
		if (!side) continue;
		const qty = Number(e.qty);
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

	return {
		totals,
		daily: [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
		byProject: [...byProject.values()].sort((a, b) => b.input + b.output - (a.input + a.output)),
		windowDays,
		generatedAt: new Date().toISOString(),
	};
}
