import { attachmentUploadFields, type AttachmentRecord, type AttachmentRecordFields, type TenantId } from '@substrat-run/contracts';
import {
  bytesStream,
  isSizedByteStream,
  verifiedStream,
  witnessedStream,
  type ByteBody,
  type ByteStream,
  type IncrementalSha256,
  type SizedByteStream,
} from './byte-stream.js';

/** What `provisionBlobStore` needs to mint (or idempotently re-resolve) a per-tenant
 *  blob store (#473). Keyed by (tenant, vertical, binding), exactly like tenant stores. */
export interface BlobStoreProvisionInput {
  tenantId: TenantId;
  /** The vertical the store belongs to — its `blobStoreNeed` binding is scoped to it. */
  vertical: string;
  /** The declared `blobStoreNeed.binding` this store satisfies (SCREAMING_SNAKE). */
  binding: string;
}

/**
 * A live per-tenant blob store (#473) — the byte side of the attachment surface. The
 * contract is async and byte-shaped (Uint8Array + web-standard types only) because the
 * store is only reachable asynchronously on Cloudflare (an `R2Bucket` binding); the pure
 * adapter backs it with a per-tenant directory and resolves immediately.
 *
 * Keys are PLATFORM-DERIVED (`attachmentBlobKey`), never caller-supplied strings — the
 * per-scope prefix inside a per-tenant store is constructed in kernel/adapter code, which
 * is what turns "scope/<id>/ is a convention" into "cross-scope keys are unwritable".
 */
export interface TenantBlobStore {
  /**
   * Write `body` under `key`. A `SizedByteStream` (#2498) is written as it is read, never
   * collected first, and refused if it carries other than its declared length. The put
   * resolves only once the whole stream has been read.
   */
  put(key: string, body: ByteBody, opts?: { contentType?: string }): Promise<void>;
  get(key: string): Promise<{ body: Uint8Array; contentType?: string } | null>;
  /**
   * The object under `key` as a stream (#2514), with the size the store holds for it, read as the
   * consumer reads it and never collected first. Optional, so a store written before it still
   * satisfies this interface: an open over such a store reads the object with `get` and hands it on
   * as a stream, which works but holds the object whole.
   */
  getStream?(key: string): Promise<{ stream: ByteStream; size: number; contentType?: string } | null>;
  delete(key: string): Promise<void>;
  /** Keys under `prefix` — the GC/ops walk. */
  list(prefix: string): Promise<string[]>;
}

/**
 * One row of the blob-store ledger (#473) — same idempotency/deploy/reap roles as
 * {@link TenantStoreRecord}: a retried provision re-resolves the same `ref`, the deploy
 * path derives which `r2_bucket` bindings must ride every serving-script upload, and a
 * tenant reap knows what to tear down.
 */
export interface BlobStoreRecord {
  tenantId: TenantId;
  vertical: string;
  binding: string;
  kind: 'blob';
  ref: string;
  createdAt: string;
}

/**
 * The blob key an attachment's bytes live under inside the per-tenant store (#473).
 * Scope-prefixed by construction: every key this platform ever writes for a scope sits
 * under `scope/<scopeId>/`, and the attachment id (a fresh ULID per upload) makes keys
 * write-once — the two properties the attachment integrity story rests on. Exported so
 * both adapters (and an ops GC walk) derive the same key; module and route code never do.
 */
export function attachmentBlobKey(scopeId: string, attachmentId: string): string {
  return `scope/${scopeId}/att/${attachmentId}`;
}

declare const crypto: { subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> } };

/**
 * An attachment's integrity witness: the lowercase hex SHA-256 of its bytes (Web Crypto).
 * One definition for the hash an upload records and every read that holds bytes to it —
 * both adapters' `open`, and the extraction job (#1575).
 */
export async function attachmentSha256(body: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', body);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Write an upload's bytes to the blob store and answer the record they make (#2498) — the "bytes
 * first" half of every attachment write, one path for both adapters. The record's fields are
 * judged before a byte moves, so a record the surface would refuse lands no object. A buffer is
 * then hashed and written, as before. A stream is hashed and counted while the store reads it, so
 * it is never held whole; `sha256` is the adapter's running digest, since the kernel has none of
 * its own. The caller writes the row.
 *
 * A streamed write that fails, or whose store answers without reading the stream to its end, has
 * its object deleted and is refused: no record may witness bytes nobody saw.
 */
export async function putAttachmentBytes(
  store: TenantBlobStore,
  key: string,
  fields: AttachmentRecordFields,
  body: ByteBody,
  sha256: () => IncrementalSha256,
): Promise<AttachmentRecord> {
  const judged = attachmentUploadFields.parse(fields);
  const opts = { contentType: judged.contentType };
  if (!isSizedByteStream(body)) {
    const record = { ...judged, size: body.byteLength, sha256: await attachmentSha256(body) };
    await store.put(key, body, opts);
    return record;
  }
  const witnessed = witnessedStream(body, sha256());
  try {
    await store.put(key, witnessed.body, opts);
    return { ...judged, ...witnessed.witness() };
  } catch (err) {
    // Deleted whether the put failed or answered early: a store can commit the declared bytes
    // and still reject when the stream errors behind them (R2 does, for a body longer than it
    // declared). The key is fresh and no row names it yet, so the delete is always safe.
    await store.delete(key).catch(() => {});
    throw err;
  }
}

/**
 * The bytes of an attachment the scope has already AUTHORIZED, as a stream held to its record (#2514):
 * the "bytes" half of every streamed open, one path for both adapters, as {@link putAttachmentBytes}
 * is for the write. The caller checks the read permission first and calls this only once it passed,
 * so a refused read never reaches the store.
 *
 * The length is the record's `size`, which the upload took from the bytes themselves. The store's own
 * size for the object is held to it before the first byte, so an object that is not the recorded one
 * is refused up front. The sha256 is checked as the bytes flow ({@link verifiedStream}): a mismatch
 * errors the stream before its last chunk is handed on. A store without `getStream` is read whole with
 * `get` and handed on the same way.
 */
export async function openAttachmentByteStream(
  store: TenantBlobStore,
  key: string,
  record: AttachmentRecord,
  sha256: () => IncrementalSha256,
): Promise<OpenedAttachmentStream> {
  const missing = () =>
    new Error(
      `attachment ${record.id}: bytes missing from the blob store — the metadata row ` +
        `survived something the object did not (rewind/reap); see the #473 integrity notes`,
    );
  let source: { stream: ByteStream; size: number; contentType?: string };
  if (store.getStream) {
    const obj = await store.getStream(key);
    if (!obj) throw missing();
    source = obj;
  } else {
    const obj = await store.get(key);
    if (!obj) throw missing();
    const { stream, length } = bytesStream(obj.body);
    source = { stream, size: length, ...(obj.contentType !== undefined ? { contentType: obj.contentType } : {}) };
  }
  let body: SizedByteStream;
  try {
    body = verifiedStream({ stream: source.stream, length: source.size }, record, sha256());
  } catch (err) {
    // Refused before the first byte: the object is let go rather than left open behind the throw.
    await source.stream.getReader().cancel(err).catch(() => {});
    throw new Error(`attachment ${record.id}: ${(err as Error).message}`);
  }
  return { record, body, contentType: source.contentType ?? record.contentType };
}

/** An opened attachment: the metadata fact plus the bytes it witnesses. */
export interface OpenedAttachment {
  record: AttachmentRecord;
  body: Uint8Array;
  contentType: string;
}

/**
 * An opened attachment whose bytes are a stream (#2514): the metadata fact, and its bytes at the
 * record's `size`, read as the consumer reads them. The sha256 is checked as they pass, so a
 * mismatch errors the stream before its last chunk instead of refusing up front: a consumer that
 * has received all `size` bytes has received bytes that matched the record. One-shot: read it once,
 * or cancel it, which releases the stored object; a stream that is neither holds it until collected.
 */
export interface OpenedAttachmentStream {
  record: AttachmentRecord;
  body: SizedByteStream;
  contentType: string;
}
