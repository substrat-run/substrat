#!/usr/bin/env node
/**
 * Rate-card snapshot generator — docs/architecture/builder/harness.md §2.2, issue #663 row 1.
 *
 * Regenerates `src/rate-card.generated.ts` from TWO community catalogs and
 * cross-checks them against each other:
 *
 *   - models.dev (https://models.dev/api.json)          — primary card: sane
 *     USD-per-1M units, per-model staleness metadata.
 *   - LiteLLM (model_prices_and_context_window.json)    — authority on pricing
 *     STRUCTURE: DashScope context tiers, Anthropic above-200k thresholds,
 *     cache read/write rates. Per-token floats, converted here.
 *
 * The output is CHECKED IN and reviewed like the permission diff: a price
 * change must appear as a PR diff a human reads. This script is run manually
 * (`pnpm --filter @substrat-run/model-providers update-rate-card`), never in CI and
 * never at runtime — billing must not depend on a third-party endpoint.
 *
 * Cross-check policy: any dimension BOTH sources carry must agree exactly
 * after unit conversion, or the script exits 1 listing the disagreement — a
 * human resolves it against the provider's own price page (the `source` URLs
 * are in the output for exactly that trip). A dimension only one source
 * carries is taken with a printed warning; it is data, not confirmation.
 *
 * Env overrides for offline runs: MODELS_DEV_JSON / LITELLM_JSON = file paths.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const LITELLM_URL =
	'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

/**
 * The models we serve and bill, one row each — the pair table
 * (src/model-pairs.ts) plus nothing else. A model absent from here AND from
 * every catalog below is unpriced by design (the read side reports it as
 * unpricedTokens, never a guessed $0).
 */
const SERVED = [
	{ provider: 'qwen', id: 'qwen3.6-flash', label: 'Qwen 3.6 Flash', modelsDev: ['alibaba', 'qwen3.6-flash'], litellm: 'dashscope/qwen3.6-flash' },
	{ provider: 'qwen', id: 'qwen3.8-max', label: 'Qwen 3.8 Max', modelsDev: ['alibaba', 'qwen3.8-max'], litellm: 'dashscope/qwen3.8-max' },
	{ provider: 'anthropic', id: 'claude-sonnet-5', label: 'Claude Sonnet 5', modelsDev: ['anthropic', 'claude-sonnet-5'], litellm: 'claude-sonnet-5' },
	{ provider: 'anthropic', id: 'claude-opus-5', label: 'Claude Opus 5', modelsDev: ['anthropic', 'claude-opus-5'], litellm: 'claude-opus-5' },
];

/**
 * Whole catalogs we serve and bill, expanded model-by-model below.
 *
 * A row-per-model table works while the models are OURS to choose — the builder
 * studio runs the pair table and nothing else. A vertical's tenant picks from
 * the provider's own catalog (ticket0's `TICKET0_MODEL`, #1054), so the set is
 * the provider's to change, and curating four of twenty-seven by hand means the
 * other twenty-three price at null: metered, billed nothing, silently.
 *
 * Expansion is driven by models.dev (the primary card) and cross-checked against
 * LiteLLM exactly as a hand-written row is — a model only models.dev carries is
 * taken with the same printed single-source warning, never waved through.
 *
 * Cloudflare: the picker lists `@cf/…` — Cloudflare's own network — and those
 * are what this expands. Partner-served `vendor/model` ids stay free text in the
 * picker and unpriced here; whether the platform bills those is a separate
 * decision from whether it can price them.
 */
const SERVED_CATALOGS = [
	{
		provider: 'cloudflare',
		modelsDevProvider: 'cloudflare-workers-ai',
		litellmPrefix: 'cloudflare/',
	},
];

/** A models.dev provider's models as SERVED rows, id-sorted for a stable diff. */
function expandCatalog(modelsDev, c) {
	const provider = modelsDev[c.modelsDevProvider];
	if (!provider) throw new Error(`models.dev has no provider '${c.modelsDevProvider}'`);
	return Object.values(provider.models ?? {})
		.filter((m) => m.cost && m.cost.input !== undefined && m.cost.output !== undefined)
		.map((m) => ({
			provider: c.provider,
			id: m.id,
			label: m.name ?? m.id,
			modelsDev: [c.modelsDevProvider, m.id],
			litellm: `${c.litellmPrefix}${m.id}`,
		}))
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** A per-1M USD rate as a plain decimal string ('0.1875', '2', '0.25'). */
function dec(n) {
	if (n === null || n === undefined) return null;
	// toPrecision(12) washes out float noise from the per-token → per-1M shift
	// (1.125e-6 * 1e6 → 1.1250000000000002); Number() strips trailing zeros.
	return String(Number(Number(n).toPrecision(12)));
}

/** LiteLLM per-token float → per-1M decimal string. */
const per1M = (perToken) => (perToken === null || perToken === undefined ? null : dec(perToken * 1e6));

/**
 * Normalize one source's view of a model to the common shape:
 * { tiers: [{ upToInputTokens, input, output, cacheRead, cacheWrite }], context }
 * Tiers are ordered ascending; the last tier's bound is null (DashScope
 * overflow falls to the last tier — LiteLLM's own semantics).
 */
function fromModelsDev(m) {
	if (!m?.cost) return null;
	const c = m.cost;
	const base = {
		input: dec(c.input),
		output: dec(c.output),
		cacheRead: dec(c.cache_read ?? null),
		cacheWrite: dec(c.cache_write ?? null),
	};
	const tiers = [];
	// models.dev tiers: [{ input, output, cache_read?, tier: { type:'context', size } }]
	for (const t of c.tiers ?? []) {
		if (t.tier?.type !== 'context') continue;
		tiers.push({
			upToInputTokens: null, // upper tier; boundary comes from the PREVIOUS entry's size
			atInputTokensOver: t.tier.size,
			input: dec(t.input),
			output: dec(t.output),
			cacheRead: dec(t.cache_read ?? null) ?? base.cacheRead,
			cacheWrite: dec(t.cache_write ?? null) ?? base.cacheWrite,
		});
	}
	return {
		tiers: buildTiers(base, tiers.map((t) => ({ over: t.atInputTokensOver, rates: t }))),
		context: m.limit?.context ?? null,
	};
}

function fromLiteLlm(m) {
	if (!m) return null;
	const base = {
		input: per1M(m.input_cost_per_token ?? null),
		output: per1M(m.output_cost_per_token ?? null),
		cacheRead: per1M(m.cache_read_input_token_cost ?? null),
		cacheWrite: per1M(m.cache_creation_input_token_cost ?? null),
	};
	// Shape 1: DashScope-style explicit tier table.
	if (Array.isArray(m.tiered_pricing) && m.tiered_pricing.length) {
		const sorted = [...m.tiered_pricing].sort((a, b) => a.range[0] - b.range[0]);
		const tiers = sorted.map((t, i) => ({
			upToInputTokens: i === sorted.length - 1 ? null : t.range[1],
			input: per1M(t.input_cost_per_token ?? null),
			output: per1M(t.output_cost_per_token ?? null),
			cacheRead: per1M(t.cache_read_input_token_cost ?? null) ?? base.cacheRead,
			cacheWrite: base.cacheWrite,
		}));
		return { tiers, context: m.max_input_tokens ?? null };
	}
	// Shape 2: Anthropic-style `_above_NNNk_` threshold keys.
	const aboveKey = Object.keys(m).find((k) => /^input_cost_per_token_above_(\d+)k_tokens$/.test(k));
	if (aboveKey) {
		const kTokens = Number(aboveKey.match(/above_(\d+)k/)[1]) * 1000;
		const at = (name) => per1M(m[`${name}_above_${kTokens / 1000}k_tokens`] ?? null);
		return {
			tiers: [
				{ upToInputTokens: kTokens, ...base },
				{
					upToInputTokens: null,
					input: at('input_cost_per_token') ?? base.input,
					output: at('output_cost_per_token') ?? base.output,
					cacheRead: at('cache_read_input_token_cost') ?? base.cacheRead,
					cacheWrite: at('cache_creation_input_token_cost') ?? base.cacheWrite,
				},
			],
			context: m.max_input_tokens ?? null,
		};
	}
	return { tiers: [{ upToInputTokens: null, ...base }], context: m.max_input_tokens ?? null };
}

/** base + [{over, rates}] (ascending) → ordered tier list, last bound null. */
function buildTiers(base, overs) {
	if (!overs.length) return [{ upToInputTokens: null, ...base }];
	const sorted = [...overs].sort((a, b) => a.over - b.over);
	const tiers = [{ upToInputTokens: sorted[0].over, ...base }];
	sorted.forEach((o, i) => {
		tiers.push({
			upToInputTokens: i === sorted.length - 1 ? null : sorted[i + 1].over,
			input: o.rates.input,
			output: o.rates.output,
			cacheRead: o.rates.cacheRead,
			cacheWrite: o.rates.cacheWrite,
		});
	});
	return tiers;
}

async function load(url, envVar) {
	const local = process.env[envVar];
	if (local) return JSON.parse(await readFile(local, 'utf8'));
	const res = await fetch(url);
	if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
	return res.json();
}

/** Compare two normalized views; returns { merged, mismatches, notes }. */
function reconcile(name, md, ll) {
	const notes = [];
	const mismatches = [];
	if (!md && !ll) return { merged: null, mismatches: [`${name}: absent from BOTH catalogs`], notes };
	if (!md || !ll) {
		notes.push(`${name}: only in ${md ? 'models.dev' : 'LiteLLM'} — single-source, verify against the provider price page`);
		return { merged: md ?? ll, mismatches, notes };
	}
	if (md.tiers.length !== ll.tiers.length) {
		// Tier structure disagreement: LiteLLM is the structure authority, but a
		// human must see it — models.dev showing flat where LiteLLM tiers is the
		// exact undercharge case (docs/architecture/builder/harness.md §2.2).
		mismatches.push(
			`${name}: tier structure differs — models.dev has ${md.tiers.length} tier(s), LiteLLM ${ll.tiers.length}`,
		);
		return { merged: ll, mismatches, notes };
	}
	const merged = { tiers: [], context: md.context ?? ll.context };
	if (md.context && ll.context && md.context !== ll.context) {
		notes.push(
			`${name}: context differs (models.dev ${md.context} vs LiteLLM ${ll.context}) — models.dev may report a beta tier; taking the SMALLER for overflow math`,
		);
		merged.context = Math.min(md.context, ll.context);
	}
	md.tiers.forEach((mt, i) => {
		const lt = ll.tiers[i];
		if (mt.upToInputTokens !== lt.upToInputTokens) {
			mismatches.push(`${name}: tier ${i} boundary ${mt.upToInputTokens} vs ${lt.upToInputTokens}`);
		}
		const tier = { upToInputTokens: mt.upToInputTokens };
		for (const dim of ['input', 'output', 'cacheRead', 'cacheWrite']) {
			const a = mt[dim];
			const b = lt[dim];
			if (a !== null && b !== null && a !== b) {
				mismatches.push(`${name}: tier ${i} ${dim} disagrees — models.dev ${a} vs LiteLLM ${b} (per 1M)`);
			}
			if ((a === null) !== (b === null)) {
				notes.push(`${name}: tier ${i} ${dim} only in ${a !== null ? 'models.dev' : 'LiteLLM'} (${a ?? b})`);
			}
			tier[dim] = a ?? b;
		}
		merged.tiers.push(tier);
	});
	return { merged, mismatches, notes };
}

const modelsDev = await load(MODELS_DEV_URL, 'MODELS_DEV_JSON');
const liteLlm = await load(LITELLM_URL, 'LITELLM_JSON');

const served = [...SERVED, ...SERVED_CATALOGS.flatMap((c) => expandCatalog(modelsDev, c))];

const rows = [];
const allMismatches = [];
const allNotes = [];
for (const s of served) {
	const md = fromModelsDev(modelsDev[s.modelsDev[0]]?.models?.[s.modelsDev[1]]);
	const llRaw = liteLlm[s.litellm];
	const ll = fromLiteLlm(llRaw);
	const name = `${s.provider}:${s.id}`;
	const { merged, mismatches, notes } = reconcile(name, md, ll);
	allMismatches.push(...mismatches);
	allNotes.push(...notes);
	if (!merged) continue;
	rows.push({
		provider: s.provider,
		idPrefix: s.id,
		label: s.label,
		contextTokens: merged.context,
		tiers: merged.tiers.map((t) => ({
			upToInputTokens: t.upToInputTokens,
			inputPer1M: t.input,
			outputPer1M: t.output,
			cacheReadPer1M: t.cacheRead,
			cacheWritePer1M: t.cacheWrite,
		})),
		sources: [
			md ? `models.dev:${s.modelsDev.join('/')}` : null,
			ll ? `litellm:${s.litellm}` : null,
			llRaw?.source ?? null,
		].filter(Boolean),
	});
}

for (const n of allNotes) console.warn(`note: ${n}`);
if (allMismatches.length) {
	console.error('\nCROSS-CHECK FAILED — resolve against the provider price page, then pin or fix upstream:');
	for (const m of allMismatches) console.error(`  ✗ ${m}`);
	process.exit(1);
}

const generatedAt = new Date().toISOString().slice(0, 10);
const out = `/**
 * GENERATED by scripts/update-rate-card.mjs — DO NOT EDIT.
 *
 * Regenerate: pnpm --filter @substrat-run/model-providers update-rate-card
 * (review the diff — this file is the billing checkpoint, docs/architecture/builder/harness.md §2.2).
 *
 * Sources cross-checked at generation: models.dev api.json × LiteLLM
 * model_prices_and_context_window.json (both MIT). Rates are provider LIST
 * prices in USD per 1M tokens, decimal strings. Tier selection is
 * all-or-nothing by the request's total input tokens (DashScope/Anthropic
 * threshold semantics — the whole request bills at the tier it lands in).
 *
 * The models we choose ourselves are one authored row each; a provider whose
 * catalog a TENANT picks from is expanded whole, so a pick outside a curated
 * few is priced rather than silently free. Cloudflare is here as its own
 * Workers AI catalog (the @cf/... ids) - partner-served vendor/model ids are
 * deliberately absent: the picker keeps them free text, and billing them is a
 * decision rather than an omission.
 */
import type { ModelRate } from './pricing.js';

export const RATE_CARD_GENERATED_AT = '${generatedAt}';

export const RATE_CARD: readonly ModelRate[] = ${JSON.stringify(rows, null, '\t')};
`;

const dest = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'rate-card.generated.ts');
await writeFile(dest, out);
console.log(`wrote ${dest} (${rows.length} models, generated ${generatedAt})`);
