/**
 * Request idempotency on the operation surface (#116).
 *
 * A client whose request times out does not know whether the work happened. It
 * retries, and a second work order exists. This is the vocabulary that lets the
 * retry return the FIRST response instead of doing the work twice.
 *
 * ## This is not the event spine's idempotency
 *
 * Consumers have been required-idempotent since the beginning and the contract
 * suite checks it: a consumer may see an event more than once and must settle to
 * the same state. That is about the spine re-delivering. This is about a CLIENT
 * re-sending — a different boundary, a different actor, and no relationship
 * between the two beyond the word.
 *
 * ## Why the wire half lives here and the rest does not
 *
 * The same split `concurrency.ts` makes one file over: contracts sits below the
 * spine, so it can say what the header is called, what makes a key well-formed
 * and what makes two requests the same request. It must not know which table
 * remembers the answer. `@substrat-run/kernel`'s `idempotency.ts` owns that, and
 * the adapters own where it runs.
 *
 * ## The property that makes this cheap
 *
 * Invokes are serialised per scope in both adapters (`rt.actor.enqueue`, the
 * ScopeDO's queue), so a duplicate cannot overlap the original — by the time the
 * retry takes its turn, the first request has committed or rolled back. Every
 * other implementation of this feature needs an in-flight state and a 409 for
 * "still running"; this one does not, and the reason is a property of the host
 * rather than an accident worth relying on quietly.
 */

/** The request header carrying the client's retry token. */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/**
 * Set on a response the server did not compute — it replayed a recorded one.
 *
 * Advisory, and worth having anyway: without it a retry is indistinguishable
 * from a first request that happened to succeed, which makes "did my key work?"
 * unanswerable from the client side and turns every integration test of a retry
 * path into a database query.
 */
export const IDEMPOTENCY_REPLAYED_HEADER = 'Idempotency-Replayed';

/**
 * The header a cross-origin browser client cannot read unless the server says it
 * may — the same trap `PAGE_EXPOSED_HEADERS` and `CONCURRENCY_EXPOSED_HEADERS`
 * document, and the mildest of the three: an unexposed `Idempotency-Replayed`
 * costs a client an observation, never a guarantee. The dedupe still happened.
 */
export const IDEMPOTENCY_EXPOSED_HEADERS = [IDEMPOTENCY_REPLAYED_HEADER] as const;

/**
 * How long a key is remembered: 24 hours.
 *
 * Long enough to cover the retries anything sane performs — an agent's backoff,
 * a queue's redelivery, a person reloading a page that failed — and short enough
 * that the recorded responses are a cache rather than an archive.
 *
 * The window is not only a storage bound, and the other reason is the one worth
 * writing down: a recorded response is a SECOND COPY of whatever the operation
 * returned, sitting in the scope database outside the erasure path that reaches
 * the outbox (a shred nulls `payload` and keeps the row; it does not know about
 * this table). A copy that expires in a day is defensible. One that expires in a
 * quarter is a disclosure nobody declared, and one that never expires is a second
 * database of personal data with no owner.
 */
export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * The largest result that is recorded for replay: 128 KiB of JSON.
 *
 * Above it the key is still recorded — with no body — and a replay is REFUSED
 * rather than re-executed. That is the fail-closed direction: refusing a retry
 * costs a caller an error it can act on, while re-running the operation is the
 * duplicate this feature exists to prevent, arrived at through the feature
 * itself. Writes return entity-shaped results and do not approach this; a list
 * read might, and a list read never carries a key (the mount forwards the header
 * on unsafe methods only).
 */
export const IDEMPOTENCY_RESULT_LIMIT = 128 * 1024;

/** Longest key accepted, matching the IETF draft's guidance for the header. */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

/**
 * Is this a key we will store and compare?
 *
 * Visible ASCII, bounded, non-empty. Deliberately permissive about STRUCTURE — a
 * UUID is the convention and this refuses to require one, because a client whose
 * natural key is an order number should not have to hash it into a shape we
 * prefer. What it refuses is a key that would make the table a place to put
 * things: control characters, whitespace, and anything unbounded.
 *
 * The key is never interpreted. It is compared, and it is scoped to the subject
 * that sent it, so one client's choice of key cannot collide with another's.
 */
export function isValidIdempotencyKey(key: string): boolean {
  if (key.length === 0 || key.length > IDEMPOTENCY_KEY_MAX_LENGTH) return false;
  return /^[\x21-\x7e]+$/.test(key);
}

/**
 * Deterministic JSON — the same value serialises to the same string, whatever
 * order its keys arrived in.
 *
 * `JSON.stringify` preserves insertion order, so `{a:1,b:2}` and `{b:2,a:1}`
 * produce different text for the same request. A fingerprint built on that would
 * call a retry a different request roughly whenever a client rebuilt its body
 * from a map — which is to say, unpredictably, and in production rather than in
 * a test.
 *
 * Arrays keep their order, because in a request body order IS meaning (the
 * second line item is not the first). Only object keys are sorted.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` is absent, not a value — `JSON.stringify` drops such a property
    // and so must this, or an optional field explicitly passed as `undefined`
    // would fingerprint differently from the same field simply omitted.
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * What makes two requests the same request: the operation and its PARSED input.
 *
 * **Parsed, not raw**, and that is load-bearing. The host parses every invocation
 * against the operation's declared schema before anything else runs, which
 * applies defaults — so a retry that omits an optional field the original sent
 * explicitly at its default value is the same request, and fingerprinting the raw
 * body would call it a different one and refuse the retry with a 409.
 *
 * The operation name is inside the hash rather than beside it in the key, so a
 * client reusing one key for two different operations is a MISMATCH (409) rather
 * than two independent records. A key is a client's assertion that "this is the
 * same request I sent before"; two operations is the clearest possible case of
 * that assertion being false, and silently honouring it would replay one
 * operation's response for another one's call.
 *
 * SHA-256 via Web Crypto — the same API in Node, Workers and browsers, per the
 * repo's standing rule against node-only imports and against hand-rolled hashes.
 */
export async function requestFingerprint(operation: string, input: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson([operation, input ?? null]));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The `conflict` reason slugs this feature owns.
 *
 * Slugs rather than codes, per the closed taxonomy: a module never invents a
 * code, it narrows an existing one with a reason it owns. Both are `conflict`
 * (409) because both mean the same thing to a client — *the key you sent is not
 * available for this request* — and differ only in why, which is what the slug
 * carries.
 */
export const IDEMPOTENCY_REUSED = 'idempotency_key_reused';
export const IDEMPOTENCY_REPLAY_UNAVAILABLE = 'idempotency_replay_unavailable';
