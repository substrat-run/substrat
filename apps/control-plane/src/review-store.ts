import type { PlatformActorId } from '@substrat-run/contracts';
import { validateReviewArchive } from './review-archive.js';

/** Phase-0 receipt only. It makes no claim that any gate has run. */
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

export class ReviewValidationError extends Error {}
export class ReviewCollisionError extends Error {}

// Pinned to the checklist bundled with this release. The test holds these values
// to the source files, so a checklist or plugin bump cannot silently go unstamped.
export const REVIEW_CHECKLIST_DIGEST = '9704ba1c0abdef09cec51a0b377ec48e678fdb7f577a8d57c86343cf66a98eab';
export const REVIEW_PLUGIN_VERSION = '0.6.0';
const REVIEW_DAYS = 30;

const recordKey = (id: string) => `records/${id}.json`;
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
): Promise<ReviewReceipt> {
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
  return receipt;
}

export async function readReview(bucket: R2Bucket, actor: PlatformActorId, id: string, now = new Date()): Promise<ReviewReceipt | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const object = await bucket.get(recordKey(id));
  if (!object) return null;
  const receipt = await object.json<ReviewReceipt>();
  return receipt.actor === actor && Date.parse(receipt.expiresAt) > now.getTime() ? receipt : null;
}

export async function listReviews(bucket: R2Bucket, actor: PlatformActorId, cursor?: string, now = new Date()): Promise<{ entries: ReviewReceipt[]; cursor: string | null }> {
  const listed = await bucket.list({ prefix: actorPrefix(actor), limit: 100, ...(cursor ? { cursor } : {}) });
  const entries = await Promise.all(listed.objects.map(async (object) => {
    const id = object.key.slice(actorPrefix(actor).length + 17);
    return readReview(bucket, actor, id, now);
  }));
  return { entries: entries.filter((entry): entry is ReviewReceipt => entry !== null), cursor: listed.truncated ? listed.cursor : null };
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
        recordKey(receipt.id), archiveKey(receipt.id, 'source'), archiveKey(receipt.id, 'base'),
        indexKey(receipt.actor, receipt.createdAt, receipt.id),
        expiryKey(receipt.expiresAt, receipt.id),
      ]);
      removed++;
    }
    if (pending || !page.truncated) break;
  }
  return removed;
}
