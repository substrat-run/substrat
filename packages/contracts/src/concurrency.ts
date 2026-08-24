/**
 * Optimistic concurrency on the operation surface (#129).
 *
 * Two people open the same record, both save, and the second write silently
 * destroys the first. Nobody notices until the data is gone — there is no error,
 * no log line, and no way to reconstruct what was lost. This is the vocabulary
 * that lets an operation refuse the second write instead.
 *
 * ## What a version is, and why it is not in here
 *
 * The version is the ULID of the last event about the entity (`entityVersionOf`
 * in the kernel, #901). This module holds only the WIRE half — the header names
 * and the comparison — because contracts sits below the spine: it can say what an
 * `ETag` is called and what makes one match, and must not know which table
 * answers the question.
 *
 * ## Why an opaque token rather than a number
 *
 * A caller compares; it never reads. That is what lets the version be a ULID
 * today and something else later without a client noticing, and it is also what
 * stops a client doing arithmetic on it — `If-Match: <version + 1>` is not a
 * thing anyone can write.
 *
 * ## The direction this fails
 *
 * ANY event about the entity moves the version, including one that changed
 * nothing the caller read. So a precondition built on it is CONSERVATIVE: it can
 * refuse a write that would in fact have been safe, and it cannot admit one that
 * would not. Documented here as well as in the kernel because this is the half a
 * client author reads when they are debugging a 412 they believe is spurious.
 */

/**
 * The response header carrying an entity's current version.
 *
 * Strong, never weak (`W/"…"`): the comparison is exact, and a weak validator
 * means "semantically equivalent", which is precisely the judgement no generic
 * layer is entitled to make about a domain entity.
 */
export const ETAG_HEADER = 'ETag';

/** The request header carrying the version the caller believes it is writing over. */
export const IF_MATCH_HEADER = 'If-Match';

/**
 * The headers a cross-origin browser client cannot read unless the server says it
 * may — the same trap already documented for `Link` and `X-Total-Count` in
 * `PAGE_EXPOSED_HEADERS`, and worse here.
 *
 * A `Link` a browser cannot read looks like "there is only one page". An `ETag` a
 * browser cannot read looks like nothing at all: `response.headers.get('ETag')` is
 * `null`, the client sends no `If-Match`, the server has nothing to compare, and
 * every write succeeds. The protection silently switches itself off, in the one
 * deployment shape (an SPA on another origin) where two editors are most likely.
 *
 * So a vertical exposing its API cross-origin must expose these, and this constant
 * is what it lists rather than a string it retypes.
 */
export const CONCURRENCY_EXPOSED_HEADERS = [ETAG_HEADER] as const;

/**
 * Format a version as an `ETag` value.
 *
 * Quoted, per RFC 9110 §8.8.3 — an entity-tag is a quoted string and a bare token
 * is malformed. Intermediaries do parse this: an unquoted value is the kind of
 * thing that works against a dev server and is stripped by a proxy in production.
 */
export function etagOf(version: string): string {
  return `"${version}"`;
}

/**
 * Does the caller's `If-Match` admit this version?
 *
 * Handles the three spellings RFC 9110 §13.1.1 allows a client to send: the quoted
 * tag, a comma-separated list of them, and `*` (meaning "any current version" —
 * i.e. the entity must merely EXIST, which for us means it has a version at all).
 *
 * A weak tag (`W/"…"`) never matches. §13.1.1 requires the strong comparison
 * function for `If-Match`, and honouring a weak one here would admit exactly the
 * write this exists to refuse.
 *
 * `version` is null when the entity has no events yet. Nothing matches that except
 * an absent header, which is not this function's call to make — a caller that sent
 * `If-Match` against an entity with no version is asking to write over something
 * that was never written, and gets a refusal.
 */
export function ifMatchAdmits(ifMatch: string, version: string | null): boolean {
  const candidates = ifMatch
    .split(',')
    .map((raw) => raw.trim())
    .filter((raw) => raw.length > 0);
  if (candidates.includes('*')) return version !== null;
  if (version === null) return false;
  return candidates.includes(etagOf(version));
}
