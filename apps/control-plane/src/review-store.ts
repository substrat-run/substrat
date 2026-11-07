import type { PlatformActorId } from '@substrat-run/contracts';
import { validateReviewArchive } from './review-archive.js';
import type { NotSentRule } from './review-diff.js';
import { gatesNotRun, type ReviewFinding, type ReviewGate } from './review-reader.js';
import { REVIEW_PLUGIN_VERSION, REVIEW_RULES_DIGEST } from './review-rules.generated.js';

export type ReviewState = 'received' | 'completed' | 'skipped' | 'incomplete' | 'partial';

/** What the reader half writes once, beside the receipt: the review's outcome. Never the prompt or a transcript. */
export interface ReviewResult {
  state: Exclude<ReviewState, 'received'>;
  /** Why the review is not `completed`; null when it is. */
  reason: string | null;
  gates: ReviewGate[];
  findings: ReviewFinding[];
  checkedClean: string[];
  notApplicable: string[];
  notSent: Array<{ path: string; rule: NotSentRule }>;
  deleted: string[];
  fullTree: boolean;
  model: { spec: string; label: string } | null;
  runner: { version: string };
  usage: { inputTokens: number; outputTokens: number; reported: boolean } | null;
  dropped: number;
  parseFailures: number;
  startedAt: string;
  finishedAt: string;
  /**
   * The rules digest and plugin version the reader half read under, stamped when it read. They
   * replace intake's stamp on the record, so a deploy between upload and read never names rules
   * the review was not read against.
   */
  checklistDigest: string;
  pluginVersion: string;
}

/**
 * A review as it is read: the intake receipt, overlaid with the result once the reader half has
 * written one. `headline` is derived here, at read, and never stored.
 */
export interface ReviewRecord extends Omit<ReviewResult, 'state' | 'startedAt' | 'finishedAt'> {
  id: string;
  actor: PlatformActorId;
  sourceSha256: string;
  baseSha256: string | null;
  checklistDigest: string;
  pluginVersion: string;
  state: ReviewState;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  expiresAt: string;
  headline: string;
}

/** The stored receipt (phase 0's shape, unchanged). */
export interface ReviewReceipt {
  id: string;
  actor: PlatformActorId;
  sourceSha256: string;
  baseSha256: string | null;
  checklistDigest: string;
  pluginVersion: string;
  state: 'received';
  model: null;
  findings: [];
  createdAt: string;
  expiresAt: string;
}

/**
 * The report's first line. A finding counts as blocking only when a script confirmed it, so every
 * reader finding is advisory (D4). The line never reads clean while any gate is `not run`,
 * `failed` or `blocked`, and it counts dropped reader findings and changed files not sent.
 */
export function reviewHeadline(record: Pick<ReviewRecord, 'state' | 'reason' | 'findings' | 'gates' | 'checklistDigest' | 'dropped' | 'notSent'>): string {
  const blocking = record.findings.filter((f) => f.severity === 'blocking' && (f.confirmation as string) === 'script').length;
  const advisory = record.findings.length - blocking;
  const parts = [`Substrat review: ${blocking} blocking, ${advisory} advisory`, `rules ${record.checklistDigest.slice(0, 12)}`];
  for (const status of ['failed', 'blocked', 'not run'] as const) {
    if (record.gates.some((g) => g.status === status)) parts.push(`gates ${status}`);
  }
  if (record.gates.length === 0) parts.push('gates not run');
  if (record.dropped > 0) parts.push(`${record.dropped} dropped`);
  if (record.notSent.length > 0) parts.push(`${record.notSent.length} not sent`);
  if (record.state !== 'completed') parts.push(record.reason ? `${record.state}: ${record.reason}` : record.state);
  return parts.join(' · ');
}

function recordOf(receipt: ReviewReceipt, result: ReviewResult | null): ReviewRecord {
  const base: Omit<ReviewRecord, 'headline'> = result
    ? { ...receipt, ...result }
    : {
        ...receipt, reason: null, gates: gatesNotRun('the review has not run yet'), findings: [], checkedClean: [], notApplicable: [],
        notSent: [], deleted: [], fullTree: receipt.baseSha256 === null, model: null, runner: { version: REVIEW_PLUGIN_VERSION },
        usage: null, dropped: 0, parseFailures: 0, startedAt: null, finishedAt: null,
      };
  return { ...base, headline: reviewHeadline(base) };
}

export class ReviewValidationError extends Error {}
export class ReviewCollisionError extends Error {}

// The rules digest and plugin version come from review-rules.generated.ts, which
// `pnpm lint:review-checklist` holds to the source files.
export const REVIEW_CHECKLIST_DIGEST = REVIEW_RULES_DIGEST;
export { REVIEW_PLUGIN_VERSION };
const REVIEW_DAYS = 30;

const recordKey = (id: string) => `records/${id}.json`;
const resultKey = (id: string) => `results/${id}.json`;
const archiveKey = (id: string, kind: 'source' | 'base') => `archives/${id}/${kind}.tar.gz`;
const actorPrefix = (actor: PlatformActorId) => `actors/${encodeURIComponent(actor)}/`;
const indexKey = (actor: PlatformActorId, createdAt: string, id: string) =>
  `${actorPrefix(actor)}${String(8_640_000_000_000_000 - Date.parse(createdAt)).padStart(16, '0')}-${id}`;
const expiryKey = (expiresAt: string, id: string) => `expiry/${expiresAt}/${id}`;

export async function receiveReview(
  bucket: R2Bucket,
  actor: PlatformActorId,
  input: { source: File; sourceSha256: string; base?: File; baseSha256?: string },
  now = new Date(),
): Promise<ReviewRecord> {
  if (input.base && !input.baseSha256 || !input.base && input.baseSha256) {
    throw new ReviewValidationError('base archive and digest must be supplied together');
  }
  try {
    await validateReviewArchive(input.source, input.sourceSha256);
    if (input.base) await validateReviewArchive(input.base, input.baseSha256!);
  } catch (error) {
    throw new ReviewValidationError(error instanceof Error ? error.message : 'invalid archive');
  }
  const id = crypto.randomUUID();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + REVIEW_DAYS * 86_400_000).toISOString();
  const receipt: ReviewReceipt = {
    id, actor,
    sourceSha256: input.sourceSha256,
    baseSha256: input.baseSha256 ?? null,
    checklistDigest: REVIEW_CHECKLIST_DIGEST,
    pluginVersion: REVIEW_PLUGIN_VERSION,
    state: 'received', model: null, findings: [], createdAt, expiresAt,
  };
  const createdKeys: string[] = [];
  const putNew = async (key: string, value: string | ArrayBuffer): Promise<void> => {
    const stored = await bucket.put(key, value, { onlyIf: { etagDoesNotMatch: '*' } });
    if (!stored) throw new ReviewCollisionError('review object key already exists');
    createdKeys.push(key);
  };
  try {
    await putNew(archiveKey(id, 'source'), await input.source.arrayBuffer());
    if (input.base) await putNew(archiveKey(id, 'base'), await input.base.arrayBuffer());
    await putNew(recordKey(id), JSON.stringify(receipt));
    await putNew(indexKey(actor, createdAt, id), id);
    await putNew(expiryKey(expiresAt, id), id);
  } catch (error) {
    await Promise.allSettled(createdKeys.map((key) => bucket.delete(key)));
    throw error;
  }
  return recordOf(receipt, null);
}

/** The stored receipt, for the reader half, which reads it under no actor. */
export async function readReceipt(bucket: R2Bucket, id: string): Promise<ReviewReceipt | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  return (await (await bucket.get(recordKey(id)))?.json<ReviewReceipt>()) ?? null;
}

export async function readReviewArchive(bucket: R2Bucket, id: string, kind: 'source' | 'base'): Promise<R2ObjectBody | null> {
  return bucket.get(archiveKey(id, kind));
}

/** Whether the reader half has written this review's result. */
export async function hasReviewResult(bucket: R2Bucket, id: string): Promise<boolean> {
  return (await bucket.head(resultKey(id))) !== null;
}

/**
 * The reader half's one write (Q6c): create-only, so a second alarm, a retry racing a first
 * attempt, or a replay writes nothing. Returns false when a result was already there.
 */
export async function writeReviewResult(bucket: R2Bucket, id: string, result: ReviewResult): Promise<boolean> {
  return (await bucket.put(resultKey(id), JSON.stringify(result), { onlyIf: { etagDoesNotMatch: '*' } })) !== null;
}

export async function readReview(bucket: R2Bucket, actor: PlatformActorId, id: string, now = new Date()): Promise<ReviewRecord | null> {
  const receipt = await readReceipt(bucket, id);
  if (!receipt || receipt.actor !== actor || Date.parse(receipt.expiresAt) <= now.getTime()) return null;
  const result = (await (await bucket.get(resultKey(id)))?.json<ReviewResult>()) ?? null;
  return recordOf(receipt, result);
}

export async function listReviews(bucket: R2Bucket, actor: PlatformActorId, cursor?: string, now = new Date()): Promise<{ entries: ReviewRecord[]; cursor: string | null }> {
  const listed = await bucket.list({ prefix: actorPrefix(actor), limit: 100, ...(cursor ? { cursor } : {}) });
  const entries = await Promise.all(listed.objects.map(async (object) => {
    const id = object.key.slice(actorPrefix(actor).length + 17);
    return readReview(bucket, actor, id, now);
  }));
  return { entries: entries.filter((entry): entry is ReviewRecord => entry !== null), cursor: listed.truncated ? listed.cursor : null };
}

/** Runs in the platform's existing daily sweep. Expired bytes are removed together. */
export async function pruneReviews(bucket: R2Bucket, now = new Date()): Promise<number> {
  let removed = 0;
  for (;;) {
    const page = await bucket.list({ prefix: 'expiry/', limit: 100 });
    if (page.objects.length === 0) break;
    let pending = false;
    for (const object of page.objects) {
      const expiresAt = object.key.slice('expiry/'.length, 'expiry/'.length + 24);
      if (Date.parse(expiresAt) > now.getTime()) { pending = true; break; }
      const id = object.key.slice('expiry/'.length + 25);
      const receipt = await (await bucket.get(recordKey(id)))?.json<ReviewReceipt>();
      if (!receipt) { await bucket.delete(object.key); continue; }
      await bucket.delete([
        recordKey(receipt.id), resultKey(receipt.id), archiveKey(receipt.id, 'source'), archiveKey(receipt.id, 'base'),
        indexKey(receipt.actor, receipt.createdAt, receipt.id),
        expiryKey(receipt.expiresAt, receipt.id),
      ]);
      removed++;
    }
    if (pending || !page.truncated) break;
  }
  return removed;
}
