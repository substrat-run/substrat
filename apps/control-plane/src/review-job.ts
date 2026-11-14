import { DurableObject } from 'cloudflare:workers';
import { CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import { modelAttribution, scopeId, tenantId, type ModelUsageLine } from '@substrat-run/contracts';
import { parseModelSpec, providerRow } from '@substrat-run/model-providers';
import { createModelHost, type ModelHost, type ModelRun } from '@substrat-run/vertical-host/model';
import { diffReview, REVIEW_MAX_DIFF_BYTES } from './review-diff.js';
import { assemble, estimateTokens, gatesNotRun, parseReply, reviewPrompt, reviewSystem } from './review-reader.js';
import { REVIEW_PLUGIN_VERSION, REVIEW_RULES_DIGEST } from './review-rules.generated.js';
import { hasReviewResult, readReceipt, readReviewArchive, writeReviewResult, type ReviewReceipt, type ReviewResult } from './review-store.js';

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
/** Attempts at the model, each exactly one HTTP call: the AI SDK's own retries are off. */
export const REVIEW_MAX_ATTEMPTS = 3;
/** The wait before each retry of a transient model error: after attempt 1, after attempt 2. */
export const REVIEW_RETRY_DELAYS_MS: readonly number[] = [60_000, 5 * 60_000];
export const REVIEW_MODEL_TIMEOUT_MS = 5 * 60_000;
/** How soon a job whose record could not be written tries again. */
export const REVIEW_WRITE_RETRY_MS = 60_000;

/** The plane's review configuration: every value a config var, none of them hardcoded at a call site. */
export interface ReviewConfig {
  /** `provider:model` on the gateway row. Unset: every review is skipped. */
  readonly model?: string | undefined;
  /** The platform's own team tenant the ledger line is filed under. Unset: the line is not written. */
  readonly platformTenant?: string | undefined;
  readonly maxDiffBytes?: number | undefined;
  readonly maxInputTokens?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
  readonly modelTimeoutMs?: number | undefined;
}

export interface ReviewJobDeps {
  readonly bucket: R2Bucket;
  readonly config: ReviewConfig;
  /** Builds the model host. Production passes the two gateway keys and no `aiBinding`; a test passes a double. */
  readonly modelHost: () => ModelHost;
  /** The ledger write: `host.admin.recordModelUsage`, deduplicated on the review id. */
  readonly recordUsage: (input: { requestId: string; line: ModelUsageLine }) => Promise<unknown>;
  readonly now?: () => Date;
  readonly log?: (event: string, detail: Record<string, unknown>) => void;
}

export type ReviewJobOutcome = { readonly done: true } | { readonly done: false; readonly retryInMs: number };

/**
 * Worth another attempt: a 408, 429 or 5xx, a call the AI SDK marked retryable (its network
 * failures included), and workerd's own `retryable` errors (a lost connection throws a plain
 * `Error`, "Network connection lost.", with `retryable: true`). A `TypeError` is a programming
 * error and is not retried; nor is anything else. With `maxRetries: 0` the SDK never wraps a
 * failure in its retry error, so there is no wrapper to look through.
 */
export function transientModelError(error: unknown): boolean {
  if (!(error instanceof Error) || error instanceof TypeError) return false;
  const e = error as Error & { statusCode?: unknown; isRetryable?: unknown; retryable?: unknown };
  if (typeof e.statusCode === 'number') return e.statusCode === 408 || e.statusCode === 429 || e.statusCode >= 500;
  return e.isRetryable === true || e.retryable === true;
}

/** What the log may say about a failed call: its status and a fixed phrase, never the provider's text. */
function failureFacts(error: unknown): { status: number | null; kind: string } {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return {
    status: typeof status === 'number' ? status : null,
    kind: error instanceof TypeError ? 'programming error' : transientModelError(error) ? 'transient' : 'refused',
  };
}

class ModelTimeout extends Error {}

const positive = (value: number | undefined, fallback: number) => (value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback);

/** Parse a numeric config var; anything that is not a positive number is the default. */
export const configNumber = (raw: string | undefined): number | undefined => (raw ? Number(raw) : undefined);

/** A result with nothing read: the shape every early exit starts from. */
function emptyResult(receipt: ReviewReceipt, startedAt: string): Omit<ReviewResult, 'state' | 'reason' | 'finishedAt'> {
  return {
    gates: gatesNotRun(), findings: [], checkedClean: [], notApplicable: [], notSent: [], deleted: [], fullTree: receipt.baseSha256 === null,
    model: null, runner: { version: REVIEW_PLUGIN_VERSION }, usage: null, dropped: 0, parseFailures: 0, startedAt,
    checklistDigest: REVIEW_RULES_DIGEST, pluginVersion: REVIEW_PLUGIN_VERSION,
  };
}

/** A ledger line still to be written, deduplicated on the review id. */
export interface UsageToRecord { readonly requestId: string; readonly line: ModelUsageLine }

/** The most paths a record lists as not sent or deleted; the full counts are kept beside them. */
export const REVIEW_LIST_MAX = 200;

/** Cap the record's path lists so the held copy stays small whatever the change: the counts stay whole. */
function capped(result: ReviewResult): ReviewResult {
  const out = { ...result };
  if (out.notSent.length > REVIEW_LIST_MAX) out.notSentCount = out.notSent.length;
  if (out.deleted.length > REVIEW_LIST_MAX) out.deletedCount = out.deleted.length;
  out.notSent = out.notSent.slice(0, REVIEW_LIST_MAX);
  out.deleted = out.deleted.slice(0, REVIEW_LIST_MAX);
  return out;
}

/** What one attempt decided: a result to store, a retry of the model call, or nothing left to do. */
export type ReviewAttempt =
  | { readonly kind: 'result'; readonly result: ReviewResult; readonly expiresAt: string; readonly usage?: UsageToRecord }
  | { readonly kind: 'retry'; readonly retryInMs: number }
  | { readonly kind: 'gone' };

/** The first open hands back the body already fetched; each later one fetches the archive again. */
function archiveOpener(bucket: R2Bucket, reviewId: string, kind: 'source' | 'base', first: R2ObjectBody): () => Promise<ReadableStream<Uint8Array>> {
  let fetched: R2ObjectBody | null = first;
  return async () => {
    const body = fetched ?? await readReviewArchive(bucket, reviewId, kind);
    fetched = null;
    if (!body) throw new Error('archive missing on re-read');
    return body.body;
  };
}

/**
 * One attempt at one review, writing nothing: the caller stores the result. `beforeCall` runs
 * just before the model is called, so the job object can count the attempt before it is spent.
 * No path touches a push: the upload has already answered.
 */
export async function reviewOnce(
  reviewId: string, attempt: number, deps: ReviewJobDeps, beforeCall: () => Promise<void> = async () => {},
): Promise<ReviewAttempt> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((event, detail) => console.log(event, detail));
  const receipt = await readReceipt(deps.bucket, reviewId);
  if (!receipt || await hasReviewResult(deps.bucket, reviewId)) return { kind: 'gone' };
  // Inside the expiry margin no result would be written, so nothing is read and no model is paid for it.
  if (insideExpiryMargin(receipt.expiresAt, now().getTime())) return { kind: 'gone' };
  const empty = emptyResult(receipt, now().toISOString());
  const gates = empty.gates;
  const finish = async (result: Omit<ReviewResult, 'finishedAt'>, usage?: UsageToRecord): Promise<ReviewAttempt> =>
    ({ kind: 'result', result: capped({ ...result, finishedAt: now().toISOString() }), expiresAt: receipt.expiresAt, ...(usage ? { usage } : {}) });
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
    {
      source: { open: archiveOpener(deps.bucket, reviewId, 'source', source), size: source.size, sha256: receipt.sourceSha256 },
      base: base && receipt.baseSha256 ? { open: archiveOpener(deps.bucket, reviewId, 'base', base), size: base.size, sha256: receipt.baseSha256 } : null,
    },
    { maxDiffBytes: positive(deps.config.maxDiffBytes, REVIEW_MAX_DIFF_BYTES) },
  );
  if (diff.kind === 'archive changed') return finish({ ...empty, state: 'incomplete', reason: 'archive changed since intake' });
  if (diff.kind === 'base unavailable') return finish({ ...empty, state: 'incomplete', reason: 'base archive unavailable or changed' });
  if (diff.kind === 'too large') return skipped(`too large: over ${diff.limit} bytes of changed text`);
  const sent = { notSent: diff.notSent.map((n) => ({ ...n })), deleted: [...diff.deleted], fullTree: diff.fullTree };
  if (diff.files.length === 0 && diff.deleted.length === 0) return skipped('no changed text to read', sent);

  const nonce = crypto.randomUUID();
  const system = reviewSystem(nonce);
  const prompt = reviewPrompt({ files: diff.files, deleted: diff.deleted, notSent: diff.notSent, gates, fullTree: diff.fullTree, nonce });
  const maxInputTokens = positive(deps.config.maxInputTokens, REVIEW_MAX_INPUT_TOKENS);
  if (estimateTokens(system) + estimateTokens(prompt) > maxInputTokens) {
    return skipped(`too large: over ${maxInputTokens} estimated input tokens`, sent);
  }
  const tenant = tenantId.safeParse(deps.config.platformTenant);
  const attribution = modelAttribution.parse({
    tenant: tenant.success ? tenant.data : UNSET_TENANT, scope: REVIEW_SENTINEL_SCOPE,
    vertical: REVIEW_RUNNER_VERTICAL, version: REVIEW_PLUGIN_VERSION, operation: REVIEW_OPERATION,
  });
  // The deadline aborts the call itself, so a late answer is never received; what the provider
  // consumed before the abort may still be billed, and has no ledger line. `maxRetries: 0` makes
  // this attempt exactly one HTTP call.
  await beforeCall();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new ModelTimeout()), positive(deps.config.modelTimeoutMs, REVIEW_MODEL_TIMEOUT_MS));
  let run: ModelRun;
  try {
    run = await host.run({
      spec, attribution, system, prompt, maxSteps: 1, maxRetries: 0, temperature: 0, abortSignal: controller.signal,
      maxOutputTokens: positive(deps.config.maxOutputTokens, REVIEW_MAX_OUTPUT_TOKENS),
    });
  } catch (error) {
    if (controller.signal.aborted) return finish({ ...empty, ...sent, state: 'incomplete', reason: 'model timed out' });
    if (transientModelError(error) && attempt + 1 < REVIEW_MAX_ATTEMPTS) {
      return { kind: 'retry', retryInMs: REVIEW_RETRY_DELAYS_MS[attempt] ?? REVIEW_RETRY_DELAYS_MS.at(-1)! };
    }
    log('review.model.failed', { reviewId, attempt, ...failureFacts(error) });
    return finish({ ...empty, ...sent, state: 'incomplete', reason: transientModelError(error) ? 'model unavailable' : 'model call failed' });
  } finally {
    clearTimeout(timer);
  }

  const usage = { inputTokens: run.line.inputTokens, outputTokens: run.line.outputTokens, reported: run.line.reported };
  // The ledger line is returned, not written: the caller holds the result first, so an object
  // reset during the ledger call cannot lose a paid reply.
  const toRecord = tenant.success ? { requestId: reviewId, line: run.line } : undefined;
  if (!toRecord) log('review.usage.unrecorded', { reviewId, reason: 'no platform tenant configured' });
  const reply = parseReply(run.text);
  const assembled = reply ? assemble(reply, diff.files) : { findings: [], dropped: 0, checkedClean: [], notApplicable: [] };
  const cut = run.finishReason === 'length';
  return finish({
    ...empty, ...sent, ...assembled,
    model: { spec, label: run.label }, usage, parseFailures: reply ? 0 : 1,
    state: cut || !reply ? 'incomplete' : 'completed',
    reason: cut ? 'output cap' : reply ? null : 'unparseable reply',
  }, toRecord);
}

/**
 * One attempt, then its ledger line and its result written, with none of the object's
 * bookkeeping. Production runs through `reviewAlarm`; this is the same attempt for the tests that
 * exercise an attempt's own decisions.
 */
export async function runReviewJob(reviewId: string, attempt: number, deps: ReviewJobDeps): Promise<ReviewJobOutcome> {
  const outcome = await reviewOnce(reviewId, attempt, deps);
  if (outcome.kind === 'retry') return { done: false, retryInMs: outcome.retryInMs };
  if (outcome.kind === 'result') {
    if (outcome.usage) await recordLedger(deps, outcome.usage);
    await writeReviewResult(deps.bucket, reviewId, outcome.result);
  }
  return { done: true };
}

/** A review never fails because of metering: a failed ledger write is logged and the result still lands. */
async function recordLedger(deps: ReviewJobDeps, usage: UsageToRecord): Promise<boolean> {
  try {
    await deps.recordUsage(usage);
    return true;
  } catch {
    (deps.log ?? ((event, detail) => console.log(event, detail)))('review.usage.unrecorded', { reviewId: usage.requestId, reason: 'ledger write failed' });
    return false;
  }
}

/** The review settings and the two gateway keys: everything the reader half is given of the plane's env (§2.2). */
export interface ReviewJobEnv {
  REVIEW_SOURCES?: R2Bucket;
  SCOPE: DurableObjectNamespace;
  CONTROL_PLANE: DurableObjectNamespace;
  REVIEW_MODEL?: string;
  REVIEW_PLATFORM_TENANT?: string;
  REVIEW_MAX_DIFF_BYTES?: string;
  REVIEW_MAX_INPUT_TOKENS?: string;
  REVIEW_MAX_OUTPUT_TOKENS?: string;
  CLOUDFLARE_AI_BASE_URL?: string;
  CLOUDFLARE_AI_API_TOKEN?: string;
}

/**
 * The plane's production wiring: config from vars; the model host given only the gateway's two
 * keys, over HTTP (no `aiBinding`); the ledger in process.
 */
export function reviewJobDeps(env: ReviewJobEnv, bucket: R2Bucket): ReviewJobDeps {
  const gateway = { CLOUDFLARE_AI_BASE_URL: env.CLOUDFLARE_AI_BASE_URL, CLOUDFLARE_AI_API_TOKEN: env.CLOUDFLARE_AI_API_TOKEN };
  return {
    bucket,
    config: {
      model: env.REVIEW_MODEL, platformTenant: env.REVIEW_PLATFORM_TENANT,
      maxDiffBytes: configNumber(env.REVIEW_MAX_DIFF_BYTES), maxInputTokens: configNumber(env.REVIEW_MAX_INPUT_TOKENS),
      maxOutputTokens: configNumber(env.REVIEW_MAX_OUTPUT_TOKENS),
    },
    modelHost: () => createModelHost({ env: gateway, sent: 'the changed files of a staff-uploaded review' }),
    recordUsage: (input) => new CloudflareScopeHost({ scope: env.SCOPE as never, controlPlane: env.CONTROL_PLANE as never }).admin.recordModelUsage(input),
  };
}

interface ReviewJobState { reviewId: string; attempt: number; writes?: number }

/** A finished attempt held in the object's storage until it is written: the result, and its ledger line until that is written. */
interface HeldResult { result: ReviewResult; expiresAt?: string; usage?: UsageToRecord }

/**
 * No result is written this close to the receipt's expiry. The daily prune removes only expired
 * receipts with their results, so a write that starts before this margin cannot land after the
 * prune has run and leave a result with nothing to expire it.
 */
export const REVIEW_WRITE_EXPIRY_MARGIN_MS = 60 * 60_000;

const insideExpiryMargin = (expiresAt: string, nowMs: number): boolean => Date.parse(expiresAt) - REVIEW_WRITE_EXPIRY_MARGIN_MS <= nowMs;

/** The longest wait between writes of a held result. Writes go on until the receipt expires. */
export const REVIEW_WRITE_RETRY_MAX_MS = 60 * 60_000;

/**
 * One alarm of one job, over the object's own storage.
 *
 * The model is called at most once per attempt and never again for a finished one: the attempt is
 * counted in storage before the call, and the finished result is held in storage before anything
 * else, with its ledger line and the receipt's expiry. A job already inside the expiry margin calls
 * no model. The ledger line is written next, before anything decides the result's fate, since the
 * call is paid for either way (deduplicated on the review id); it stays held until that write
 * succeeds, so a rejected one is tried again on the next alarm while the result is still unwritten.
 * Before each write of the result the job checks the held expiry and that the receipt is still
 * there: past expiry, or with the receipt pruned, it writes nothing and forgets the job. A job that
 * ends with its ledger line still unwritten keeps only the line, which is billable, and tries it
 * again on its own alarms until the receipt expires (`finishJob`). A failed result write retries only the write, waiting from REVIEW_WRITE_RETRY_MS and doubling to at most
 * REVIEW_WRITE_RETRY_MAX_MS. If the result cannot be held, it is written straight to R2. A transient
 * model error re-arms the next attempt. The job is forgotten once the result is written, or nothing
 * is left to write it for.
 */
export async function reviewAlarm(storage: DurableObjectStorage, deps: ReviewJobDeps | null, nowMs: () => number = Date.now): Promise<void> {
  if (!deps) {
    await storage.deleteAll();
    return;
  }
  const line = await storage.get<UnrecordedLine>('line');
  if (line) {
    await retryLine(storage, deps, line, nowMs);
    return;
  }
  const job = await storage.get<ReviewJobState>('job');
  if (!job) {
    await storage.deleteAll();
    return;
  }
  let held = await storage.get<HeldResult>('held');
  if (!held) {
    let outcome: ReviewAttempt;
    try {
      outcome = job.attempt >= REVIEW_MAX_ATTEMPTS
        ? await stoppedResult(deps.bucket, job.reviewId, 'runner interrupted')
        : await reviewOnce(job.reviewId, job.attempt, deps, () => storage.put('job', { ...job, attempt: job.attempt + 1 } satisfies ReviewJobState));
    } catch {
      console.error('review.job.failed', { reviewId: job.reviewId, reason: 'runner error' });
      // An unexpected throw still ends in a record, so a review never sits `received` for good.
      outcome = await stoppedResult(deps.bucket, job.reviewId, 'runner error').catch(() => ({ kind: 'retry', retryInMs: REVIEW_WRITE_RETRY_MS }) as const);
    }
    if (outcome.kind === 'gone') {
      await storage.deleteAll();
      return;
    }
    if (outcome.kind === 'retry') {
      await storage.setAlarm(nowMs() + outcome.retryInMs);
      return;
    }
    held = { result: outcome.result, expiresAt: outcome.expiresAt, ...(outcome.usage ? { usage: outcome.usage } : {}) };
    try {
      await storage.put('held', held);
    } catch {
      // Not holdable: write it now rather than lose it, unless nothing is left to write it for. A
      // failure here re-arms the job, whose attempt is already counted.
      console.error('review.job.failed', { reviewId: job.reviewId, reason: 'result not held' });
      // The ledger line first: a paid call has its line even when the result is no longer wanted.
      const unrecorded = held.usage && !(await recordLedger(deps, held.usage)) ? held.usage : undefined;
      if (!(await stillWanted(deps, job.reviewId, held.expiresAt, nowMs))) {
        await finishJob(storage, unrecorded, held.expiresAt, nowMs);
        return;
      }
      try {
        await writeReviewResult(deps.bucket, job.reviewId, held.result);
        await finishJob(storage, unrecorded, held.expiresAt, nowMs);
      } catch {
        await storage.setAlarm(nowMs() + REVIEW_WRITE_RETRY_MS);
      }
      return;
    }
  }
  // The ledger line first: a paid call has its line even when the result is no longer wanted.
  if (held.usage && await recordLedger(deps, held.usage)) {
    const { usage: _written, ...rest } = held;
    held = rest;
    await storage.put('held', held);
  }
  if (!(await stillWanted(deps, job.reviewId, held.expiresAt, nowMs))) {
    await finishJob(storage, held.usage, held.expiresAt, nowMs);
    return;
  }
  try {
    await writeReviewResult(deps.bucket, job.reviewId, held.result);
  } catch {
    const writes = (job.writes ?? 0) + 1;
    console.error('review.job.failed', { reviewId: job.reviewId, reason: 'record write failed', writes });
    const current = (await storage.get<ReviewJobState>('job')) ?? job;
    await storage.put('job', { ...current, writes } satisfies ReviewJobState);
    await storage.setAlarm(nowMs() + writeRetryDelay(writes));
    return;
  }
  await finishJob(storage, held.usage, held.expiresAt, nowMs);
}

/** The wait before write `writes + 1`: from REVIEW_WRITE_RETRY_MS, doubling to REVIEW_WRITE_RETRY_MAX_MS. */
const writeRetryDelay = (writes: number): number => Math.min(REVIEW_WRITE_RETRY_MS * 2 ** (writes - 1), REVIEW_WRITE_RETRY_MAX_MS);

/** A paid call's ledger line that outlived its job: the line is what the tenant is billed from. */
interface UnrecordedLine { usage: UsageToRecord; until: string; writes: number }

/**
 * Forget the job. A ledger line still unwritten is kept, alone, and retried on the object's own
 * alarms until `until` (the receipt's expiry): the prune never reaches this object, so the line
 * needs an end of its own. Without an expiry there is nothing to bound the retries by, and the
 * line is logged as unrecorded instead.
 */
async function finishJob(storage: DurableObjectStorage, usage: UsageToRecord | undefined, until: string | undefined, nowMs: () => number): Promise<void> {
  await storage.deleteAll();
  if (!usage) return;
  if (!until || Date.parse(until) <= nowMs()) {
    console.error('review.usage.unrecorded', { reviewId: usage.requestId, reason: 'ledger write failed' });
    return;
  }
  await storage.put('line', { usage, until, writes: 1 } satisfies UnrecordedLine);
  await storage.setAlarm(nowMs() + writeRetryDelay(1));
}

async function retryLine(storage: DurableObjectStorage, deps: ReviewJobDeps, line: UnrecordedLine, nowMs: () => number): Promise<void> {
  if (await recordLedger(deps, line.usage)) {
    await storage.deleteAll();
    return;
  }
  const writes = line.writes + 1;
  const next = nowMs() + writeRetryDelay(writes);
  if (next >= Date.parse(line.until)) {
    console.error('review.usage.unrecorded', { reviewId: line.usage.requestId, reason: 'ledger write failed until the review expired', writes });
    await storage.deleteAll();
    return;
  }
  await storage.put('line', { ...line, writes } satisfies UnrecordedLine);
  await storage.setAlarm(next);
}

/**
 * Whether a result is still worth writing: not within REVIEW_WRITE_EXPIRY_MARGIN_MS of the
 * receipt's expiry, and the receipt not pruned. A receipt that cannot be read is no answer: the
 * write is tried, and retried if it fails.
 */
async function stillWanted(deps: ReviewJobDeps, reviewId: string, expiresAt: string | undefined, nowMs: () => number): Promise<boolean> {
  if (expiresAt && insideExpiryMargin(expiresAt, nowMs())) return false;
  const receipt = await readReceipt(deps.bucket, reviewId).catch(() => undefined);
  return receipt !== null;
}

/** A result for a job that stopped without one of its own: `incomplete` with the reason. Gone when no receipt is left. */
async function stoppedResult(bucket: R2Bucket, reviewId: string, reason: string): Promise<ReviewAttempt> {
  const receipt = await readReceipt(bucket, reviewId);
  if (!receipt || await hasReviewResult(bucket, reviewId)) return { kind: 'gone' };
  const at = new Date().toISOString();
  return { kind: 'result', result: { ...emptyResult(receipt, at), state: 'incomplete', reason, finishedAt: at }, expiresAt: receipt.expiresAt };
}

/**
 * One object per review id, stepped by its alarm. It holds the id, the attempt and the write
 * count, and a finished result until it is written; the record lives in R2, and once the result
 * is written the object forgets everything.
 */
export class ReviewJobDO extends DurableObject<ReviewJobEnv> {
  async start(reviewId: string): Promise<void> {
    if (await this.ctx.storage.get('job')) return;
    await this.ctx.storage.put('job', { reviewId, attempt: 0 } satisfies ReviewJobState);
    await this.ctx.storage.setAlarm(Date.now());
  }

  override async alarm(): Promise<void> {
    const bucket = this.env.REVIEW_SOURCES;
    await reviewAlarm(this.ctx.storage, bucket ? reviewJobDeps(this.env, bucket) : null);
  }
}
