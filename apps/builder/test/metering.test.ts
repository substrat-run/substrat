/**
 * The studio metering pipeline (#646/#663) end-to-end over the REAL metering
 * engine: `recordTurnUsage`'s token + record-time cost entries, the turn-id
 * dedupe, and `studioUsage`'s read-side pricing — recorded cost preferred,
 * flat-totals fallback for pre-#663 rows, unpriced models never guessed at $0.
 *
 * Only the Cloudflare adapter CLASS is mocked (test/studio-shim.ts): it adapts
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platformActorId, principalId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { STUDIO_NODE } from '../src/studio.js';
import { startStudio, stopStudio } from './studio-shim.js';

type MeteringModule = typeof import('../src/metering.js');

vi.mock('@substrat-run/adapter-cloudflare', () => import('./studio-shim.js'));

const FLASH = 'qwen:qwen3.6-flash';

describe('studio metering (recordTurnUsage → studioUsage)', () => {
	let studio: ReturnType<typeof startStudio>;
	let metering: MeteringModule;
	const env = { SCOPE: {} } as unknown as import('../src/studio.js').StudioEnv;

	beforeEach(async () => {
		studio = startStudio();
		// Fresh modules per test: studio.ts memoizes its provisioning promise at
		// module scope, and each test gets its own sqlite dir.
		vi.resetModules();
		metering = await import('../src/metering.js');
	});

	afterEach(stopStudio);

	/**
	 * A scope stub holding the studio role — how a test writes ledger rows that
	 * recordTurnUsage did NOT write (pre-#663 turns recorded tokens only).
	 * Requires the studio to be provisioned first (any recordTurnUsage or
	 * studioUsage call does that).
	 */
	async function ledgerScope() {
		const staff = platformActorId.parse(ulid());
		const writer = principalId.parse(ulid());
		await studio.host.admin.assignRole(staff, {
			principalId: writer,
			roleKey: studio.ownerRoleKey,
			node: {
				tenantId: STUDIO_NODE.tenantId,
				scopeId: STUDIO_NODE.scopeId,
			},
		});
		return studio.host.getScope(writer, STUDIO_NODE.tenantId, STUDIO_NODE.scopeId);
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
		// At the over-256k tier: 200k plain × $1 + 800k cached × $0.1
		// + 100k output × $4 = $0.68.
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
				listUsd: '0.68',
				billedUsd: '0.816',
			},
		]);
		expect(report.byProject).toEqual([
			{ projectId: 'proj-1', input: 1_000_000, output: 100_000, turns: 1 },
		]);
		expect(report.cost).toEqual({ listUsd: '0.68', billedUsd: '0.816', unpricedTokens: 0 });
	});

	describe('the team\'s bill (reportTurnUsage → the control plane\'s ledger)', () => {
		const TENANT = '01JZ0000000000000000TENANT';
		const turn = { tenantId: TENANT, projectId: 'p1', turnId: 't-bill', model: FLASH, inputTokens: 1_000_000, outputTokens: 100_000, elapsedMs: 4200 };
		const ledgerEnv = (answer: Response) => {
			const posted: { url: string; token: string | null; body: { requestId: string; line: Record<string, unknown> } }[] = [];
			const fetch = async (url: string, init: RequestInit) => {
				posted.push({ url, token: new Headers(init.headers).get('x-service-token'), body: JSON.parse(init.body as string) });
				return answer;
			};
			return { posted, env: { ...env, CONTROL_PLANE_SVC: { fetch }, CP_SERVICE_TOKEN: 'svc' } as unknown as import('../src/metering.js').LedgerEnv };
		};

		it('files the turn under the team, priced, keyed on the turn', async () => {
			const { env: ledger, posted } = ledgerEnv(new Response('{}'));
			await metering.reportTurnUsage(ledger, turn);
			expect(posted).toHaveLength(1);
			expect(posted[0]).toMatchObject({ url: 'https://control-plane/api/model-usage', token: 'svc' });
			expect(posted[0]!.body.requestId).toBe('builder:t-bill');
			expect(posted[0]!.body.line).toMatchObject({
				attribution: { tenant: TENANT, scope: STUDIO_NODE.scopeId, vertical: '@substrat-run/builder', operation: 'builder/turn' },
				model: FLASH,
				provider: 'qwen',
				modelId: 'qwen3.6-flash',
				reported: true,
				inputTokens: 1_000_000,
				outputTokens: 100_000,
				elapsedMs: 4200,
			});
			expect(posted[0]!.body.line.listUsd).toEqual(expect.stringMatching(/^\d/));
		});

		it('says a provider reported nothing rather than billing zero tokens as a price', () => {
			const line = metering.turnUsageLine({ ...turn, inputTokens: 0, outputTokens: 0 }, new Date(0));
			expect(line).toMatchObject({ reported: false, listUsd: null });
		});

		it('keeps an unpriced model\'s tokens on the bill, with no guessed price', () => {
			const line = metering.turnUsageLine({ ...turn, model: 'cloudflare:deepseek/deepseek-v4-pro' }, new Date(0));
			expect(line).toMatchObject({ reported: true, inputTokens: 1_000_000, listUsd: null });
		});

		it('still records the studio ledger when the control plane refuses, and does not throw', async () => {
			const error = vi.spyOn(console, 'error').mockImplementation(() => {});
			const { env: ledger } = ledgerEnv(new Response('no', { status: 503 }));
			await metering.reportTurnUsage(ledger, turn);
			expect((await metering.studioUsage(env)).totals).toEqual({ input: 1_000_000, output: 100_000 });
			expect(error).toHaveBeenCalledWith(expect.stringContaining('the control plane answered 503'));
			error.mockRestore();
		});
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
		expect(report.byModel[0]).toMatchObject({ listUsd: '1.4', billedUsd: '1.68' });
		expect(report.byProject[0]?.turns).toBe(1);
	});

	it('prices token rows that predate cost entries via flat totals — the pre-#663 fallback', async () => {
		await metering.studioUsage(env); // provision the studio so the legacy writer can be granted
		await recordLegacyTokens(FLASH, 2_000_000, 100_000);

		const report = await metering.studioUsage(env);
		// 2M × $1/1M + 100k × $4/1M = $2.4.
		expect(report.byModel[0]).toMatchObject({
			model: FLASH,
			input: 2_000_000,
			output: 100_000,
			listUsd: '2.4',
			billedUsd: '2.88',
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
		// Tokens: legacy + new. Cost: ONLY the new turn — 40k × $0.25/1M + 2k × $1.5/1M.
		expect(row).toMatchObject({
			input: 2_040_000,
			output: 102_000,
			listUsd: '0.013',
			billedUsd: '0.0156',
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
