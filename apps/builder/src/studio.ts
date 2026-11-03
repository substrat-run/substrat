/**
 * The studio's own kernel scope (#646) — what the builder keeps about itself.
 *
 * The studio is staff-only and has no customer tenant to bill, so its records
 * live in the builder's OWN scope: a CP-less kernel host (the sandbox-clean
 * vertical shape — `CloudflareScopeHost` with no control plane, provisioned via
 * `provisionScopeLocal`) whose ScopeDO bundles two engines:
 *
 *   - **metering** — the usage ledger, one entry per turn and model (metering.ts);
 *   - **assistant** — the record of each project's conversation, one thread per
 *     project, every turn's events appended as they happen (record.ts).
 *
 * One fixed node, Meridian-DEV_NODE-style constants. Team boundaries are held by
 * the per-team BuilderAgent, which only ever names its own projects' threads;
 * moving both records to per-team scopes is the step after this one.
 */
import { permissionKey, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import { meteringModule, PERM as METERING_PERM } from '@substrat-run/engine-metering';
import { ASSISTANT_PERM, assistantModule } from '@substrat-run/engine-assistant';

/** The modules the studio's ScopeDO bundles — worker.ts builds the DO class from this list. */
export const STUDIO_MODULES = [meteringModule, assistantModule];

/** The studio's fixed node — valid ULIDs, same shape as Meridian's DEV_NODE. */
export const STUDIO_NODE = {
	tenantId: tenantId.parse('01JZ0000000000000000STD001'),
	scopeId: scopeId.parse('01JZ0000000000000000STD002'),
};

/**
 * The recording principal, and the owner of every project thread. Ledger
 * entries carry it as `created_by`, and the user's side of a thread is written
 * as it. Who typed a message is recorded beside it (record.ts), not as the
 * thread's subject: a project's conversation is the team's, not one person's.
 */
export const STUDIO_RECORDER = principalId.parse('01JZ0000000000000000STD003');

/**
 * The turn loop's own principal: it writes the assistant's side of a thread,
 * which `assistant:run` reserves to a system principal. No person holds it, so
 * the record of what the model and the studio did is not something a person
 * could write into.
 */
export const STUDIO_HOST = principalId.parse('01JZ0000000000000000STD004');

const STUDIO_ROLE = 'studio-metering';
const HOST_ROLE = 'studio-turn-loop';

export interface StudioEnv {
	SCOPE: DurableObjectNamespace;
}

export function hostFor(env: StudioEnv): CloudflareScopeHost {
	const host = new CloudflareScopeHost({ scope: env.SCOPE });
	for (const module of STUDIO_MODULES) host.registerModule(module);
	return host;
}

/**
 * Provision-or-heal, memoized per isolate. `provisionScopeLocal` is idempotent
 * (migrations no-op once applied; the projection rewrites the same rows), so a
 * cold start re-running it is a self-heal, not a hazard — and it is how an
 * already-provisioned studio scope gains the assistant engine's tables and
 * keys. Entitlements are deliberately omitted: an un-projected scope trusts
 * upstream (#304), which is the truthful state — the studio has no plan.
 */
let ready: Promise<void> | null = null;

export function ensureStudio(env: StudioEnv): Promise<void> {
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
						ASSISTANT_PERM.use,
					].map((p) => permissionKey.parse(p)),
					source: 'vertical',
				},
				{ key: HOST_ROLE, permissions: [ASSISTANT_PERM.run], source: 'vertical', holder: 'system' },
			],
			ownerRoleKey: STUDIO_ROLE,
		});
		await host.assignScopeRole(STUDIO_NODE.scopeId, STUDIO_HOST, HOST_ROLE);
		// Meters are per-model and configured lazily by recordTurnUsage — a new
		// model id must never require a deploy to start metering.
	})().catch((err) => {
		ready = null; // a failed bootstrap must not poison every later turn
		throw err;
	});
	return ready;
}

/** A stub acting as `principal` in the studio scope, provisioned first. */
export async function studioScope(env: StudioEnv, principal: typeof STUDIO_RECORDER = STUDIO_RECORDER) {
	await ensureStudio(env);
	return hostFor(env).getScope(principal, STUDIO_NODE.tenantId, STUDIO_NODE.scopeId);
}
