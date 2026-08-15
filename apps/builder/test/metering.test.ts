/**
 * The studio metering pipeline (#646/#663) end-to-end over the REAL metering
 * engine: `recordTurnUsage`'s token + record-time cost entries, the turn-id
 * dedupe, and `studioUsage`'s read-side pricing — recorded cost preferred,
 * flat-totals fallback for pre-#663 rows, unpriced models never guessed at $0.
 *
 * Only the Cloudflare adapter CLASS is mocked: a shim that adapts
 * `provisionScopeLocal` onto a `SqliteScopeHost` via its HostAdmin (the same
 * recipe engine-test-kit uses). The module, its migrations, the permission
 * checker and the per-meter dedupe are all real — so a drift between
 * metering.ts's assumed entry shape (`meterKey`/`qty`/`subject`/`occurredAt`)
 * and what the engine actually returns fails HERE, not in production.
 *
 * pricing.test.ts owns the math with literal expected values; these tests
 * reuse a few of those literals to prove the record → ledger → read plumbing
 * delivers them intact.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platformActorId, principalId, type PrincipalId, type ScopeId, type TenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';

type MeteringModule = typeof import('../src/metering.js');

/**
 * The shim's per-test state. `vi.mock` factories are hoisted above imports, so
 * the mock reaches the live host through this holder instead of a closure.
 */
const shim = vi.hoisted(() => ({
	current: null as {
		host: {
			registerModule(m: unknown): void;
			getScope(p: unknown, t: unknown, s: unknown): Promise<unknown>;
		};
		registered: Set<string>;
		provision(input: unknown): Promise<void>;
	} | null,
}));

vi.mock('@substrat-run/adapter-cloudflare', () => ({
	CloudflareScopeHost: class {
		// metering.ts constructs a fresh host per call and re-registers the module
		// each time; the sqlite host refuses duplicates, so the shim dedupes.
		registerModule(m: { manifest: { id: string } }): void {
			const s = shim.current;
			if (!s) throw new Error('shim not initialized');
			if (s.registered.has(m.manifest.id)) return;
			s.registered.add(m.manifest.id);
			s.host.registerModule(m);
		}
		provisionScopeLocal(input: unknown): Promise<void> {
			const s = shim.current;
			if (!s) throw new Error('shim not initialized');
			return s.provision(input);
		}
		getScope(p: unknown, t: unknown, s: unknown): Promise<unknown> {
			const cur = shim.current;
			if (!cur) throw new Error('shim not initialized');
			return cur.host.getScope(p, t, s);
		}
	},
}));

const FLASH = 'qwen:qwen3.6-flash';

describe('studio metering (recordTurnUsage → studioUsage)', () => {
	let dir: string;
	let host: SqliteScopeHost;
	/** Captured from provisionScopeLocal so tests can mint extra ledger writers. */
	let studioRoleKey = '';
	let metering: MeteringModule;
	const env = { SCOPE: {} } as unknown as import('../src/metering.js').StudioEnv;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), 'builder-metering-'));
		host = new SqliteScopeHost({ dir });
		shim.current = {
			host: host as never,
			registered: new Set(),
			provision: async (raw) => {
				const input = raw as {
					tenantId: TenantId;
					scopeId: ScopeId;
					owner: PrincipalId;
					roles: { key: string; permissions: string[]; source: string }[];
					ownerRoleKey: string;
				};
				studioRoleKey = input.ownerRoleKey;
				const staff = platformActorId.parse(ulid());
				await host.admin.createTenant(staff, {
					id: input.tenantId,
					slug: 'studio',
					name: 'Builder studio',
				});
				// The sqlite host enforces entitlements at invoke (unlike the un-projected
				// CF scope, which trusts upstream) — grant the module's own key.
				await host.admin.grantEntitlement(staff, input.tenantId, 'metering');
				await host.provisionScope(staff, {
					tenantId: input.tenantId,
					scopeId: input.scopeId,
					jurisdiction: 'global',
				});
				await host.admin.activateScope(staff, input.tenantId, input.scopeId);
				for (const role of input.roles) {
					await host.admin.defineRole(staff, input.tenantId, role as never);
				}
				await host.admin.assignRole(staff, {
					principalId: input.owner,
					roleKey: input.ownerRoleKey,
					node: { tenantId: input.tenantId, scopeId: input.scopeId },
				});
			},
		};
		// Fresh module per test: metering.ts memoizes its provisioning promise at
		// module scope, and each test gets its own sqlite dir.
		vi.resetModules();
		metering = await import('../src/metering.js');
	});

	afterEach(() => {
		shim.current = null;
		rmSync(dir, { recursive: true, force: true });
	});

	/**
	 * A scope stub holding the studio role — how a test writes ledger rows that
	 * recordTurnUsage did NOT write (pre-#663 turns recorded tokens only).
	 * Requires the studio to be provisioned first (any recordTurnUsage or
	 * studioUsage call does that).
	 */
	async function ledgerScope() {
		const staff = platformActorId.parse(ulid());
		const writer = principalId.parse(ulid());
		await host.admin.assignRole(staff, {
			principalId: writer,
			roleKey: studioRoleKey,
			node: {
				tenantId: metering.STUDIO_NODE.tenantId,
				scopeId: metering.STUDIO_NODE.scopeId,
			},
		});
		return host.getScope(writer, metering.STUDIO_NODE.tenantId, metering.STUDIO_NODE.scopeId);
	}

	/** A pre-#663 turn: token meters only, no `ai.cost.usd.*` entry. */
	async function recordLegacyTokens(model: string, input: number, output: number): Promise<void> {
		const scope = await ledgerScope();
		const sides = [
			['input', input],
			['output', output],
		] as const;
		for (const [side, qty] of sides) {
			const meter = `ai.tokens.${side}.${model}`;
			await scope.invoke('metering/configure-meter', { key: meter, kind: 'counter', unit: 'tokens' });
			await scope.invoke('metering/record', {
				meter,
				qty: String(qty),
				subject: { entityType: 'builder-project', entityId: 'legacy-proj' },
				dedupeKey: ulid(),
			});
		}
	}

	it('records a turn and reads it back priced from the record-time cost entry', async () => {
		// flash publishes no cache-read rate, so the cached slice bills at the
		// input rate: 1M × $0.1875/1M + 100k × $1.125/1M = 0.1875 + 0.1125.
		await metering.recordTurnUsage(env, {
			projectId: 'proj-1',
			turnId: ulid(),
			model: FLASH,
			inputTokens: 1_000_000,
			outputTokens: 100_000,
			cachedInputTokens: 800_000,
			stepUsage: [{ inputTokens: 1_000_000, outputTokens: 100_000, cachedInputTokens: 800_000 }],
		});

		const report = await metering.studioUsage(env);
		// Cache slices are slices OF input — counted per model, never added to totals.
		expect(report.totals).toEqual({ input: 1_000_000, output: 100_000 });
		expect(report.byModel).toEqual([
			{
				model: FLASH,
				input: 1_000_000,
				output: 100_000,
				cacheRead: 800_000,
				cacheWrite: 0,
				listUsd: '0.3',
				billedUsd: '0.36',
			},
		]);
		expect(report.byProject).toEqual([
			{ projectId: 'proj-1', input: 1_000_000, output: 100_000, turns: 1 },
		]);
		expect(report.cost).toEqual({ listUsd: '0.3', billedUsd: '0.36', unpricedTokens: 0 });
	});

	it('replaying a turn (same turnId) never double-bills — tokens or cost', async () => {
		const turn = {
			projectId: 'proj-1',
			turnId: ulid(),
			model: FLASH,
			inputTokens: 1_000_000,
			outputTokens: 100_000,
			stepUsage: [{ inputTokens: 1_000_000, outputTokens: 100_000 }],
		};
		await metering.recordTurnUsage(env, turn);
		await metering.recordTurnUsage(env, turn);

		const report = await metering.studioUsage(env);
		expect(report.totals).toEqual({ input: 1_000_000, output: 100_000 });
		expect(report.byModel[0]).toMatchObject({ listUsd: '0.3', billedUsd: '0.36' });
		expect(report.byProject[0]?.turns).toBe(1);
	});

	it('prices token rows that predate cost entries via flat totals — the pre-#663 fallback', async () => {
		await metering.studioUsage(env); // provision the studio so the legacy writer can be granted
		await recordLegacyTokens(FLASH, 2_000_000, 100_000);

		const report = await metering.studioUsage(env);
		// 2M × $0.1875/1M + 100k × $1.125/1M = 0.375 + 0.1125
		expect(report.byModel[0]).toMatchObject({
			model: FLASH,
			input: 2_000_000,
			output: 100_000,
			listUsd: '0.4875',
			billedUsd: '0.585',
		});
		expect(report.cost.unpricedTokens).toBe(0);
	});

	it('mixed history: the recorded cost wins and legacy tokens go unpriced — the accepted #663 transition gap', async () => {
		// Once ANY cost entry exists for a model, the read side sums recorded
		// costs only; token rows recorded before cost meters existed show in the
		// token columns but price at $0. Accepted (staff-only spend, self-corrects
		// as new turns dominate) — this test pins it as CHOSEN behavior, so a
		// future fix rewrites the expectation deliberately instead of tripping on it.
		await metering.studioUsage(env);
		await recordLegacyTokens(FLASH, 2_000_000, 100_000);
		await metering.recordTurnUsage(env, {
			projectId: 'proj-1',
			turnId: ulid(),
			model: FLASH,
			inputTokens: 40_000,
			outputTokens: 2_000,
			stepUsage: [{ inputTokens: 40_000, outputTokens: 2_000 }],
		});

		const report = await metering.studioUsage(env);
		const row = report.byModel.find((m) => m.model === FLASH);
		// Tokens: legacy + new. Cost: ONLY the new turn — 40k × $0.1875/1M + 2k × $1.125/1M.
		expect(row).toMatchObject({
			input: 2_040_000,
			output: 102_000,
			listUsd: '0.00975',
			billedUsd: '0.0117',
		});
	});

	it('a model with no rate-card entry reports tokens as unpriced, never a guessed $0', async () => {
		await metering.recordTurnUsage(env, {
			projectId: 'proj-1',
			turnId: ulid(),
			model: 'ollama:qwen3-coder',
			inputTokens: 5_000,
			outputTokens: 500,
			stepUsage: [{ inputTokens: 5_000, outputTokens: 500 }],
		});

		const report = await metering.studioUsage(env);
		expect(report.byModel).toEqual([
			{
				model: 'ollama:qwen3-coder',
				input: 5_000,
				output: 500,
				cacheRead: 0,
				cacheWrite: 0,
				listUsd: null,
				billedUsd: null,
			},
		]);
		expect(report.cost).toEqual({ listUsd: '0', billedUsd: '0', unpricedTokens: 5_500 });
	});

	it('v0 flat token keys fold in as an unattributed, unpriced row', async () => {
		await metering.studioUsage(env);
		const scope = await ledgerScope();
		await scope.invoke('metering/configure-meter', {
			key: 'ai.tokens.input',
			kind: 'counter',
			unit: 'tokens',
		});
		await scope.invoke('metering/record', {
			meter: 'ai.tokens.input',
			qty: '500',
			dedupeKey: ulid(),
		});

		const report = await metering.studioUsage(env);
		expect(report.byModel).toEqual([
			{ model: null, input: 500, output: 0, cacheRead: 0, cacheWrite: 0, listUsd: null, billedUsd: null },
		]);
		expect(report.totals.input).toBe(500);
		expect(report.cost.unpricedTokens).toBe(500);
	});
});
