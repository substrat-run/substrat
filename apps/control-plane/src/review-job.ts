import { DurableObject } from 'cloudflare:workers';
import { CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import { modelAttribution, scopeId, tenantId, type ModelUsageLine } from '@substrat-run/contracts';
import { parseModelSpec, providerRow } from '@substrat-run/model-providers';
import { createModelHost, type ModelHost } from '@substrat-run/vertical-host/model';
import { diffReview, REVIEW_MAX_DIFF_BYTES } from './review-diff.js';
import { assemble, estimateTokens, gatesNotRun, parseReply, REVIEW_SYSTEM, reviewPrompt } from './review-reader.js';
import { REVIEW_PLUGIN_VERSION } from './review-rules.generated.js';
import { hasReviewResult, readReceipt, readReviewArchive, writeReviewResult, type ReviewResult } from './review-store.js';

/**
 * The platform-owned scope every review's usage line is filed under until reviews belong to a
 * tenant's scope (#1073), as the builder files its turns under its studio node.
 */
export const REVIEW_SENTINEL_SCOPE = scopeId.parse('01JZ0000000000000000RVW001');
/** Stands in for the tenant on the line when the plane names none; that line is never written. */
const UNSET_TENANT = tenantId.parse('01JZ0000000000000000RVW000');
export const REVIEW_RUNNER_VERTICAL = '@substrat-run/review-runner';
export const REVIEW_OPERATION = 'review/read';

export const REVIEW_MAX_OUTPUT_TOKENS = 8_000;
export const REVIEW_MAX_INPUT_TOKENS = 120_000;
export const REVIEW_MAX_ATTEMPTS = 3;
/** The wait before each retry of a transient model error: after attempt 1, after attempt 2. */
export const REVIEW_RETRY_DELAYS_MS: readonly number[] = [60_000, 5 * 60_000];
export const REVIEW_MODEL_TIMEOUT_MS = 5 * 60_000;

/** The plane's review configuration: every value a config var, none of them hardcoded at a call site. */
export interface ReviewConfig {
  /** `provider:model` on the gateway row. Unset: every review is skipped. */
  readonly model?: string | undefined;
  /** The platform's own team tenant the ledger line is filed under. Unset: the line is not written. */
  readonly platformTenant?: string | undefined;
  readonly maxDiffBytes?: number;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly modelTimeoutMs?: number;
}

export interface ReviewJobDeps {
  readonly bucket: R2Bucket;
  readonly config: ReviewConfig;
  /** Builds the model host. Production passes the plane's env with no `aiBinding`; a test passes a double. */
  readonly modelHost: () => ModelHost;
  /** The ledger write: `host.admin.recordModelUsage`, deduplicated on the review id. */
  readonly recordUsage: (input: { requestId: string; line: ModelUsageLine }) => Promise<unknown>;
  readonly now?: () => Date;
  readonly log?: (event: string, detail: Record<string, unknown>) => void;
}

export type ReviewJobOutcome = { readonly done: true } | { readonly done: false; readonly retryInMs: number };

/** 429, 5xx and a network failure are worth another attempt; nothing else is. */
export function transientModelError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  const status = (error as { statusCode?: unknown; status?: unknown } | null)?.statusCode ?? (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number') return status === 429 || status >= 500;
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'AI_RetryError' && transientModelError((error as { lastError?: unknown }).lastError);
}

class GuardRefusal extends Error {}
class ModelTimeout extends Error {}

const positive = (value: number | undefined, fallback: number) => (value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback);

/** Parse a numeric config var; anything that is not a positive number is the default. */
export const configNumber = (raw: string | undefined): number | undefined => (raw ? Number(raw) : undefined);

/**
 * One attempt at one review. Every path that finishes writes the result once, with a reason when
 * it is not `completed`, and none of them touches a push: the upload has already answered.
 */
export async function runReviewJob(reviewId: string, attempt: number, deps: ReviewJobDeps): Promise<ReviewJobOutcome> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((event, detail) => console.log(event, detail));
  const receipt = await readReceipt(deps.bucket, reviewId);
  if (!receipt || await hasReviewResult(deps.bucket, reviewId)) return { done: true };
  const startedAt = now().toISOString();
  const gates = gatesNotRun();
  const empty = {
    gates, findings: [], checkedClean: [], notApplicable: [], notSent: [], deleted: [], fullTree: receipt.baseSha256 === null,
    model: null, runner: { version: REVIEW_PLUGIN_VERSION }, usage: null, dropped: 0, parseFailures: 0, startedAt,
  } satisfies Partial<ReviewResult>;
  const finish = async (result: Omit<ReviewResult, 'finishedAt'>): Promise<ReviewJobOutcome> => {
    await writeReviewResult(deps.bucket, reviewId, { ...result, finishedAt: now().toISOString() });
    return { done: true };
  };
  const skipped = (reason: string, extra: Partial<ReviewResult> = {}) => finish({ ...empty, ...extra, state: 'skipped', reason });

  const spec = deps.config.model?.trim();
  if (!spec) return skipped('no model configured');
  let provider: string;
  try {
    provider = parseModelSpec(spec).provider;
  } catch {
    return skipped('model path not the gateway');
  }
  const row = providerRow(provider);
  if (row?.kind !== 'compatible' || row.request !== 'cloudflare-gateway') return skipped('model path not the gateway');
  const host = deps.modelHost();
  if (!host.status(spec).configured) return skipped('model not configured on this plane');

  const source = await readReviewArchive(deps.bucket, reviewId, 'source');
  const base = receipt.baseSha256 ? await readReviewArchive(deps.bucket, reviewId, 'base') : null;
  if (!source || (receipt.baseSha256 && !base)) return finish({ ...empty, state: 'incomplete', reason: 'archive missing' });
  const diff = await diffReview(
    { source: { stream: () => source.body, size: source.size }, base: base ? { stream: () => base.body, size: base.size } : null },
    { maxDiffBytes: positive(deps.config.maxDiffBytes, REVIEW_MAX_DIFF_BYTES) },
  );
  if (diff.kind === 'too large') return skipped(`too large: over ${diff.limit} bytes of changed text`);
  const sent = { notSent: diff.notSent.map((n) => ({ ...n })), deleted: [...diff.deleted], fullTree: diff.fullTree };
  if (diff.files.length === 0 && diff.deleted.length === 0) return skipped('no changed text to read', sent);

  const prompt = reviewPrompt({ files: diff.files, deleted: diff.deleted, gates, fullTree: diff.fullTree, nonce: crypto.randomUUID() });
  const maxInputTokens = positive(deps.config.maxInputTokens, REVIEW_MAX_INPUT_TOKENS);
  const tenant = tenantId.safeParse(deps.config.platformTenant);
  const attribution = modelAttribution.parse({
    tenant: tenant.success ? tenant.data : UNSET_TENANT, scope: REVIEW_SENTINEL_SCOPE,
    vertical: REVIEW_RUNNER_VERTICAL, version: REVIEW_PLUGIN_VERSION, operation: REVIEW_OPERATION,
  });
  const guarded = createModelHostGuard(host, () => {
    if (estimateTokens(REVIEW_SYSTEM) + estimateTokens(prompt) > maxInputTokens) throw new GuardRefusal();
  });
  let run: Awaited<ReturnType<ModelHost['run']>>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    run = await Promise.race([
      guarded.run({ spec, attribution, system: REVIEW_SYSTEM, prompt, maxSteps: 1, maxOutputTokens: positive(deps.config.maxOutputTokens, REVIEW_MAX_OUTPUT_TOKENS), temperature: 0 }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ModelTimeout()), positive(deps.config.modelTimeoutMs, REVIEW_MODEL_TIMEOUT_MS)); }),
    ]);
  } catch (error) {
    if (error instanceof GuardRefusal) return skipped(`too large: over ${maxInputTokens} estimated input tokens`, sent);
    if (error instanceof ModelTimeout) return finish({ ...empty, ...sent, state: 'incomplete', reason: 'model timed out' });
    if (transientModelError(error) && attempt + 1 < REVIEW_MAX_ATTEMPTS) {
      return { done: false, retryInMs: REVIEW_RETRY_DELAYS_MS[attempt] ?? REVIEW_RETRY_DELAYS_MS.at(-1)! };
    }
    log('review.model.failed', { reviewId, attempt, message: error instanceof Error ? error.message : String(error) });
    return finish({ ...empty, ...sent, state: 'incomplete', reason: transientModelError(error) ? 'model unavailable' : 'model call failed' });
  } finally {
    clearTimeout(timer);
  }

  const usage = { inputTokens: run.line.inputTokens, outputTokens: run.line.outputTokens, reported: run.line.reported };
  if (tenant.success) {
    // A review never fails because of metering: a failed write is logged and the result still lands.
    await deps.recordUsage({ requestId: reviewId, line: run.line }).catch((error: unknown) => {
      log('review.usage.unrecorded', { reviewId, message: error instanceof Error ? error.message : String(error) });
    });
  } else {
    log('review.usage.unrecorded', { reviewId, message: 'no platform tenant configured' });
  }
  const reply = parseReply(run.text);
  const assembled = reply ? assemble(reply, diff.files) : { findings: [], dropped: 0, checkedClean: [], notApplicable: [] };
  const capped = run.finishReason === 'length';
  return finish({
    ...empty, ...sent, ...assembled,
    model: { spec, label: run.label }, usage, parseFailures: reply ? 0 : 1,
    state: capped || !reply ? 'incomplete' : 'completed',
    reason: capped ? 'output cap' : reply ? null : 'unparseable reply',
  });
}

/** The guard runs before the call and refuses what is too large; nothing is sent when it throws. */
function createModelHostGuard(host: ModelHost, guard: () => void): ModelHost {
  return { status: host.status, run: async (request) => { guard(); return host.run(request); } };
}

export interface ReviewJobEnv {
  REVIEW_SOURCES?: R2Bucket;
  SCOPE: DurableObjectNamespace;
  CONTROL_PLANE: DurableObjectNamespace;
  REVIEW_MODEL?: string;
  REVIEW_PLATFORM_TENANT?: string;
  REVIEW_MAX_DIFF_BYTES?: string;
  REVIEW_MAX_INPUT_TOKENS?: string;
  REVIEW_MAX_OUTPUT_TOKENS?: string;
}

/** The plane's production wiring: config from vars, the gateway over HTTP (no `aiBinding`), the ledger in process. */
export function reviewJobDeps(env: ReviewJobEnv, bucket: R2Bucket): ReviewJobDeps {
  return {
    bucket,
    config: {
      model: env.REVIEW_MODEL, platformTenant: env.REVIEW_PLATFORM_TENANT,
      maxDiffBytes: configNumber(env.REVIEW_MAX_DIFF_BYTES), maxInputTokens: configNumber(env.REVIEW_MAX_INPUT_TOKENS),
      maxOutputTokens: configNumber(env.REVIEW_MAX_OUTPUT_TOKENS),
    },
    modelHost: () => createModelHost({ env: env as unknown as Record<string, string | undefined>, sent: 'the changed files of a staff-uploaded review' }),
    recordUsage: (input) => new CloudflareScopeHost({ scope: env.SCOPE as never, controlPlane: env.CONTROL_PLANE as never }).admin.recordModelUsage(input),
  };
}

interface ReviewJobState { reviewId: string; attempt: number }

/**
 * One object per review id, stepped by its alarm. It holds only the id and the attempt; the
 * record lives in R2, and once the result is written the object forgets everything.
 */
export class ReviewJobDO extends DurableObject<ReviewJobEnv> {
  async start(reviewId: string): Promise<void> {
    if (await this.ctx.storage.get('job')) return;
    await this.ctx.storage.put('job', { reviewId, attempt: 0 } satisfies ReviewJobState);
    await this.ctx.storage.setAlarm(Date.now());
  }

  override async alarm(): Promise<void> {
    const job = await this.ctx.storage.get<ReviewJobState>('job');
    const bucket = this.env.REVIEW_SOURCES;
    if (!job || !bucket) {
      await this.ctx.storage.deleteAll();
      return;
    }
    const deps = reviewJobDeps(this.env, bucket);
    let outcome: ReviewJobOutcome;
    try {
      outcome = await runReviewJob(job.reviewId, job.attempt, deps);
    } catch (error) {
      // An unexpected throw still ends in a record, so a review never sits `received` for good.
      console.error('review.job.failed', { reviewId: job.reviewId, message: error instanceof Error ? error.message : String(error) });
      const receipt = await readReceipt(bucket, job.reviewId).catch(() => null);
      if (receipt) {
        const at = new Date().toISOString();
        await writeReviewResult(bucket, job.reviewId, {
          state: 'incomplete', reason: 'runner error', gates: gatesNotRun(), findings: [], checkedClean: [], notApplicable: [],
          notSent: [], deleted: [], fullTree: receipt.baseSha256 === null, model: null, runner: { version: REVIEW_PLUGIN_VERSION },
          usage: null, dropped: 0, parseFailures: 0, startedAt: at, finishedAt: at,
        }).catch(() => false);
      }
      outcome = { done: true };
    }
    if (outcome.done) {
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.ctx.storage.put('job', { ...job, attempt: job.attempt + 1 } satisfies ReviewJobState);
    await this.ctx.storage.setAlarm(Date.now() + outcome.retryInMs);
  }
}
