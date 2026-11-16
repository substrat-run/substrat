/**
 * The seeded corpus, read by candidate models: the measurement behind choosing `REVIEW_MODEL`
 * (RFC hosted-review-runner Q1a, Q7 C; #2365). An opt-in probe that spends real money. It never
 * runs in CI and sets no configuration: choosing the model is the owner's decision.
 *
 *   pnpm --filter @substrat-run/control-plane review-corpus --dry-run --model <spec> …
 *   pnpm --filter @substrat-run/control-plane review-corpus --budget 5 --model <spec> … [--repeat 2]
 *
 * Each read is the hosted job's own: the seed's diff from `diffReview`, the job's system and
 * prompt, `REVIEW_CALL` with the job's output cap, and `readReply` (the assembler's drop rule
 * included). Only the `cloudflare` gateway row is a candidate (Q3e). Its two variables are read
 * from the environment, or from `--env-file` (only those two lines, never printed).
 *
 * Spend: before any call, the worst case (every read at the output cap) is estimated from the
 * rate card and refused over `--budget`; during the run, a read starts only while what is spent
 * plus its own worst case stays under it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { modelAttribution } from '@substrat-run/contracts';
import { parseModelSpec, providerRow } from '@substrat-run/model-providers';
import { createModelHost, type ModelRun } from '@substrat-run/vertical-host/model';
import type { ChangedFile } from '../src/review-diff.js';
import { estimateTokens, gatesNotRun, readReply, REVIEW_CALL, REVIEW_MAX_OUTPUT_TOKENS, reviewPrompt, reviewSystem } from '../src/review-reader.js';
import { REVIEW_PLUGIN_VERSION, REVIEW_RULES_DIGEST } from '../src/review-rules.generated.js';
import { loadSeeds, priceOf, resolveExpectations, scoreSeed, summarise, summaryTable, type Resolved, type Seed, type SeedRun } from './corpus.mts';
import { materialize, SEEDS_DIR, seedDiff } from './materialize.mts';

const GATEWAY_VARS = ['CLOUDFLARE_AI_BASE_URL', 'CLOUDFLARE_AI_API_TOKEN', 'CLOUDFLARE_AI_GATEWAY_ID'] as const;
/** The job's own deadline for one call. */
const CALL_TIMEOUT_MS = 5 * 60_000;

const { values } = parseArgs({
  options: {
    model: { type: 'string', multiple: true, default: [] },
    seed: { type: 'string', multiple: true, default: [] },
    repeat: { type: 'string', default: '1' },
    budget: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    'env-file': { type: 'string' },
    out: { type: 'string' },
    /** The output cap. Default: the job's own; the job reads `REVIEW_MAX_OUTPUT_TOKENS` from config, so a higher one is a setting, not a code change. */
    'max-output': { type: 'string' },
  },
});

function gatewayEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of GATEWAY_VARS) if (process.env[name]) env[name] = process.env[name]!;
  if (values['env-file']) {
    for (const line of readFileSync(values['env-file'], 'utf8').split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && (GATEWAY_VARS as readonly string[]).includes(m[1]!) && !env[m[1]!]) env[m[1]!] = m[2]!.replace(/^(["'])(.*)\1$/, '$2');
    }
  }
  return env;
}

interface Prepared { seed: Seed; files: readonly ChangedFile[]; resolved: Resolved[]; system: string; prompt: string; estimatedInput: number }

async function prepare(seed: Seed): Promise<Prepared> {
  const tree = materialize(seed);
  const diff = await seedDiff(tree);
  if (diff.kind !== 'diff') throw new Error(`${seed.id}: the diff is ${diff.kind}`);
  const nonce = crypto.randomUUID();
  const system = reviewSystem(nonce);
  const prompt = reviewPrompt({ files: diff.files, deleted: diff.deleted, notSent: diff.notSent, gates: gatesNotRun(), fullTree: diff.fullTree, nonce });
  return { seed, files: diff.files, resolved: resolveExpectations(seed, tree.head), system, prompt, estimatedInput: estimateTokens(system) + estimateTokens(prompt) };
}

const transient = (e: unknown) => {
  const status = (e as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === 'number' ? status === 408 || status === 429 || status >= 500 : (e as { isRetryable?: unknown })?.isRetryable === true;
};

async function main(): Promise<void> {
  const models = values.model!;
  if (models.length === 0) throw new Error('name at least one --model, e.g. cloudflare:@cf/zai-org/glm-5.3');
  for (const spec of models) {
    const row = providerRow(parseModelSpec(spec).provider);
    if (row?.kind !== 'compatible' || row.request !== 'cloudflare-gateway') throw new Error(`${spec}: not on the gateway row (Q3e)`);
  }
  const maxOutput = values['max-output'] === undefined ? REVIEW_MAX_OUTPUT_TOKENS : Number(values['max-output']);
  if (!Number.isInteger(maxOutput) || maxOutput < 1) throw new Error('--max-output is a whole number of tokens');
  const repeat = Number(values.repeat);
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error('--repeat is a whole number of reads per seed');
  const wanted = new Set(values.seed);
  const seeds = loadSeeds(SEEDS_DIR).filter((s) => wanted.size === 0 || wanted.has(s.id));
  const prepared = await Promise.all(seeds.map(prepare));

  const worst = (spec: string, p: Prepared) => Number(priceOf(spec, p.estimatedInput, maxOutput) ?? NaN);
  let total = 0;
  console.log(`rules ${REVIEW_RULES_DIGEST.slice(0, 12)} · ${prepared.length} seeds × ${repeat} · worst case at the ${maxOutput}-token output cap`);
  for (const spec of models) {
    const cost = prepared.reduce((n, p) => n + worst(spec, p), 0) * repeat;
    if (Number.isNaN(cost)) throw new Error(`${spec}: unpriced on the rate card, so its spend cannot be capped`);
    total += cost;
    const input = prepared.reduce((n, p) => n + p.estimatedInput, 0);
    console.log(`  ${spec}: ≤ $${cost.toFixed(4)} (≈${input.toLocaleString('en-US')} input tokens a pass)`);
  }
  console.log(`  total ≤ $${total.toFixed(4)}`);
  if (values['dry-run']) return;
  const budget = Number(values.budget);
  if (!(budget > 0)) throw new Error('a paid run needs --budget <usd>');
  if (total > budget) throw new Error(`the worst case $${total.toFixed(4)} is over the budget $${budget}; nothing was called`);

  const host = createModelHost({ env: gatewayEnv(), sent: 'the seeded review corpus: this repository\'s own history' });
  for (const spec of models) {
    const status = host.status(spec);
    if (!status.configured) throw new Error(`${spec}: missing ${status.missing.join(', ')}`);
  }
  const attribution = modelAttribution.parse({
    tenant: '01JZ0000000000000000RVW000', scope: '01JZ0000000000000000RVW001',
    vertical: '@substrat-run/review-runner', version: REVIEW_PLUGIN_VERSION, operation: 'review/corpus',
  });

  let spent = 0;
  const runs: SeedRun[] = [];
  // One queue per model, so a slow model does not hold up the others; the spend is shared.
  await Promise.all(models.map(async (spec) => {
    for (let pass = 0; pass < repeat; pass++) {
      for (const p of prepared) {
        if (spent + worst(spec, p) > budget) {
          console.log(`  ${spec} ${p.seed.id}: stopped, the budget would not hold another read`);
          return;
        }
        const started = Date.now();
        let run: ModelRun | null = null;
        for (let attempt = 0; attempt < 2 && !run; attempt++) {
          try {
            run = await host.run({ ...REVIEW_CALL, spec, attribution, system: p.system, prompt: p.prompt, maxOutputTokens: maxOutput, abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
          } catch (error) {
            if (attempt === 0 && transient(error)) await new Promise((r) => setTimeout(r, 10_000));
            else {
              const e = error as { statusCode?: number; message?: string; name?: string };
              console.log(`  ${spec} ${p.seed.id}: call failed (${e?.statusCode ?? e?.name}: ${String(e?.message ?? '').slice(0, 160)})`);
            }
          }
        }
        const latencyMs = Date.now() - started;
        if (!run) {
          // A failed call may still have been billed: count its worst case against the budget.
          spent += worst(spec, p);
          runs.push({ model: spec, seed: p.seed.id, kind: p.seed.kind, state: 'failed', reason: 'call failed', score: scoreSeed(p.resolved, []), dropped: 0, inputTokens: 0, outputTokens: 0, costUsd: '0', latencyMs });
          continue;
        }
        const read = readReply(run, p.files);
        const costUsd = priceOf(spec, run.line.inputTokens, run.line.outputTokens);
        spent += Number(costUsd ?? worst(spec, p));
        const score = scoreSeed(p.resolved, read.assembled.findings);
        runs.push({ model: spec, seed: p.seed.id, kind: p.seed.kind, state: read.state, reason: read.reason, score, dropped: read.assembled.dropped, inputTokens: run.line.inputTokens, outputTokens: run.line.outputTokens, costUsd, latencyMs });
        const owed = score.expected.map((e) => `${e.item}${e.hit ? '✓' : '✗'}`).join(' ') || 'clean';
        const extra = score.falseFindings.map((f) => `${f.item}@${f.file}:${f.line}`).join(' ');
        console.log(`  ${spec} ${p.seed.id}: ${read.state}${read.reason ? ` (${read.reason})` : ''} · ${owed}${extra ? ` · false ${extra}` : ''} · ${(latencyMs / 1000).toFixed(1)} s · $${costUsd ?? '?'}`);
      }
    }
  }));

  const summaries = summarise(runs);
  console.log(`\nspent $${spent.toFixed(4)} of $${budget}\n`);
  console.log(summaryTable(summaries));
  if (values.out) {
    writeFileSync(values.out, `${JSON.stringify({ rulesDigest: REVIEW_RULES_DIGEST, runner: REVIEW_PLUGIN_VERSION, at: new Date().toISOString(), repeat, maxOutput, runs, summaries }, null, 2)}\n`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
