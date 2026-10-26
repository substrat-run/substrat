import type { OpenConnection, PermissionKey } from '@substrat-run/contracts';
import type { OpenedAttachment, OpenedAttachmentStream } from './attachment-bytes.js';
import { isSizedByteStream, knownLengthInit, type ByteStream, type SizedByteStream } from './byte-stream.js';
import type { SealedSecret } from './secret-box.js';

/**
 * How hard the host tries before it gives up on one delivery (#100).
 *
 * Defaults suit a directory write. A connector making an outbound HTTP call
 * wants a longer tail — that is the whole reason this is per-executor rather
 * than a host-wide constant.
 */
export interface ExecutorRetryPolicy {
  /** Total attempts including the first. Reaching it dead-letters. Default 5. */
  maxAttempts?: number;
  /** First backoff step; doubles per attempt. Default 1000ms. `0` retries at once. */
  baseDelayMs?: number;
  /** Ceiling on the doubling. Default 300_000ms (5 min). */
  maxDelayMs?: number;
}

/**
 * The web-standard fetch surface, structurally typed.
 *
 * Declared rather than imported: the kernel depends on no platform typings, and
 * `RequestInit`/`Response` come from DOM lib in Node and from workers-types in
 * Workers. Structural typing means both satisfy this without either being
 * required — the same reason `crypto` and `TextEncoder` are declared locally.
 */
export interface FetchLike {
  (input: string, init?: ConnectorRequestInit): Promise<ConnectorResponse>;
}

/**
 * The runtime's own `fetch`, as a `FetchLike` — the ONE place the structural cast
 * lives. A host that takes a `fetch` defaults to this; a caller that hands one to a
 * connector passes this. Nobody else spells `globalThis.fetch` (`lint:bound-fetch`).
 *
 * The cast is needed at all because a real `fetch` is NOT assignable to `FetchLike`
 * under strict TypeScript: `ConnectorRequestInit.body` is a `Uint8Array` the DOM lib's
 * `BodyInit` no longer accepts unparameterized, and `signal` is `unknown`. Structurally
 * the runtime satisfies it — every field is one `fetch` reads — and this is where that
 * claim is made, once. Code typed against the DOM `fetch` itself (a `Response` in hand)
 * does not want this; `globalThis.fetch.bind(globalThis)` is that type with no cast.
 *
 * An arrow, deliberately, rather than the global handed on as a value: workerd
 * refuses the bare global invoked with any other receiver — `TypeError: Illegal
 * invocation` — and a callee is free to call what it was given as `input.fetch(…)`.
 * Node's fetch accepts any `this`, and so does the wrapper the workers vitest pool
 * installs, so no suite in this repo sees the difference; the Fortnox consent
 * callback shipped green and failed every hosted round that way (#1291). Closing
 * over the global here means the receiver is never in play, anywhere downstream.
 *
 * A `SizedByteStream` body (#2498) is converted by `fetchLikeOf`, which this is built from.
 */
export const globalFetch: FetchLike = fetchLikeOf((input, init) =>
  // Called on the global, never through a variable: workerd refuses any other receiver.
  (globalThis as unknown as { fetch: (input: string, init?: unknown) => Promise<ConnectorResponse> }).fetch(input, init),
);

/**
 * A runtime `fetch` (the global, a service binding's, a test's stand-in) as a `FetchLike`
 * (#2498): the one place a `SizedByteStream` body becomes a request the runtime can send, as
 * `knownLengthInit` builds it. The runtime takes no such value: handed one as it is, a `fetch`
 * sends its string form, `"[object Object]"`, and answers as if nothing were wrong. So
 * `globalFetch` is built from this, and both hosts pass the `fetch` they are given through it,
 * as `runPlatformSweep` does, so a sized body reaches no runtime `fetch` unconverted whichever
 * one was injected. Wrapping a `FetchLike` that is already one is harmless: a converted body is
 * no longer a `SizedByteStream`.
 */
export function fetchLikeOf(runtimeFetch: (input: string, init?: never) => Promise<ConnectorResponse>): FetchLike {
  const send = runtimeFetch as (input: string, init?: unknown) => Promise<ConnectorResponse>;
  return (input, init) => send(input, isSizedByteStream(init?.body) ? knownLengthInit({ ...init, body: init.body }) : init);
}

export interface ConnectorRequestInit {
  method?: string;
  headers?: Record<string, string>;
  /**
   * `Uint8Array` as well as `string` because a real provider upload is binary:
   * Scrive's `setfile` is `multipart/form-data`, whose body is a byte sequence a
   * string cannot carry without corrupting the file. Web `fetch` accepts both, so
   * this only widens the declared surface — the adapter passes it straight
   * through.
   *
   * A {@link SizedByteStream} as well (#2498), for a body too large to hold in memory. The
   * length is part of the value because a provider wants a `Content-Length`, and a stream
   * carries none. The runtime cannot take one as it is, so it is converted by `fetchLikeOf`:
   * `globalFetch` is built from it, and both hosts and `runPlatformSweep` pass the `fetch` they
   * are given through it. A runtime `fetch` handed straight to a connector is made a
   * `FetchLike` with `fetchLikeOf` too, never by a cast.
   */
  body?: string | Uint8Array | SizedByteStream;
  signal?: unknown;
}
export interface ConnectorResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
  /**
   * The raw bytes — for provider responses that are a file, not JSON. Scrive's
   * sealed signed PDF (`documents/{id}/files/main`) comes back as `application/pdf`,
   * which `text()` would corrupt. Web `Response` already has this, so declaring it
   * only widens the structural surface the adapter passes straight through.
   */
  arrayBuffer(): Promise<ArrayBuffer>;
  /**
   * The body as a stream (#2498), for a provider file too large to hold: read it chunk by chunk,
   * or hand it on to `upload` as a `SizedByteStream`. `null` for a response with no body, as on
   * a web `Response`, which every adapter's `fetch` returns.
   *
   * The stream carries the body as `fetch` delivers it: DECODED. A response sent with a
   * `Content-Encoding` (gzip, br) is decompressed on the way, while its `Content-Length` still
   * counts the compressed bytes, so that header is the stream's length only when the response
   * has no `Content-Encoding`. Otherwise take the length from the provider's own record of the
   * file (its item metadata); a stream sized by the wrong number is refused, not landed.
   *
   * The stream is bounded by IDLENESS, not by total transfer time (#2518). A connection's `fetch`
   * holds the connector's `timeoutMs` (default 30 s) over the call up to the headers and over a
   * buffered read, and still holds it while `body` is only looked at or never read. From the first
   * read of the stream the deadline hands over: it errors (`TimeoutError`) when the provider sends
   * no byte for `STREAM_IDLE_TIMEOUT_MS` (an empty chunk is not a byte), or when
   * `STREAM_MAX_DURATION_MS` has passed in all. A transfer that keeps flowing completes within
   * that. A stalled or endless one errors, the connection is released, and an upload reading it
   * lands no object and no row.
   *
   * OPTIONAL for the reason `headers` is: a hand-built stand-in is an object literal, and most
   * connectors never read a stream. A caller that needs one falls back to `arrayBuffer()` when it
   * is absent. Read a body once, by one of these.
   */
  readonly body?: ByteStream | null;
  /**
   * The response headers, when the runtime behind this seam has them.
   *
   * OPTIONAL, and the optionality is the whole design. Every adapter's `fetch`
   * returns a real web `Response`, which always carries headers — so a connector
   * reading one gets a value in production, always. What is not guaranteed is a
   * hand-built stand-in: a mock or an in-memory provider is a plain object
   * literal, and requiring `headers` would break every one of them for a field
   * most connectors never read.
   *
   * So a caller must handle absence, and the callers that need it do. It exists
   * because some provider instructions live ONLY in a header and a connector that
   * cannot read them has to invent a substitute: Planima answers a rate limit with
   * `Retry-After`, and a client that cannot see it backs off on a schedule of its
   * own guessing — either too soon (spending another request to be told the same
   * thing) or too late. Declaring it here is what keeps that read inside the
   * sanctioned seam instead of a structural cast in a connector.
   */
  readonly headers?: { get(name: string): string | null };
}

/**
 * A connection with its credential opened, plus egress bound to it.
 *
 * `fetch` is bound to the connection rather than sitting on the context because
 * health has to land on the right row by construction. An ambient
 * `ctx.fetch` would need the runtime to guess which connection a call belonged
 * to, and it would guess wrong the first time a connector talked to two.
 */
export interface ConnectorConnection extends OpenConnection {
  /**
   * Sanctioned egress: a timeout, and success/failure recorded against THIS
   * connection.
   *
   * The connector is handed its `fetch` rather than importing one — the same
   * move `ctx.sql` makes for module code, and for the same reason. Egress
   * policy, timeouts and health become properties of the seam instead of
   * conventions a connector author has to remember. Module code still cannot
   * reach any of this: boundary-lint R3 bans `fetch` outright, and a connector
   * is host code.
   */
  fetch(input: string, init?: ConnectorRequestInit): Promise<ConnectorResponse>;
}

/**
 * A connection opened INSIDE a dispatch (#711) — `ctx.connection(provider)`.
 *
 * Strictly more than a `ConnectorConnection`, and the difference is a scope. A
 * dispatch happens *for* one scope, which is ambient in the context, so a
 * connection opened there can reach that scope's attachments. A connection
 * reopened top-level — a probe of a candidate credential, a poll driver
 * rebuilding egress from the directory — has no such scope, and the type says so
 * rather than handing out a method that would have to throw.
 */
export interface ScopedConnectorConnection extends ConnectorConnection {
  /**
   * Read ONE attachment's bytes from the scope this delivery is for (#711) — the
   * outbound mirror of `getConnectorAttachments`, which is the return path's door.
   *
   * A signing connector sends a document. Until this existed it could only send a
   * document it RENDERED ITSELF, because `create` had no way to be handed the
   * vertical's own file: the bytes were in the attachment store, and the store was
   * unreachable from inside a dispatch. So a Swedish counterparty was asked to sign
   * a page of identifiers with BankID rather than the contract.
   *
   * **On the connection, for the same reason `fetch` is.** The read is authorized as
   * a connection, and the only connection it can correctly be authorized as is the
   * one the handler opened — this object. An ambient "the provider this connector is
   * registered under" would be a second name for the same thing, and two names for
   * one fact is how they come to disagree: `registerScriveConnector({ id: 'scrive-eu' })`
   * opens its credential as `'scrive'` and would have read as `'scrive-eu'`, so the
   * egress half kept working while the document half failed on every contract.
   * Handing the door to whoever holds the credential makes that unrepresentable.
   *
   * **Why not `getConnectorAttachments` from in here.** On the pure adapter a
   * connector runs INSIDE the scope's actor task, and every verb of that surface
   * re-enqueues on the same actor — the nested task waits on the task holding it,
   * and the invoke never returns. (Pinned in `connector-reads.test.ts`.) The adapter
   * builds this read to suit where it is running: reentrant when the caller already
   * holds the actor, ordinary and serialized when it does not.
   *
   * **Reads only, and only by id.** No `list`, deliberately. A connector that
   * SEARCHES for the document to send has to have a rule for picking among several
   * — and the return path lands the sealed signed copy on the same entity, so a
   * wrong rule mails the counterparty their own signed contract to sign again.
   * Naming the id makes that unrepresentable: the caller says which bytes, the
   * event carries it, and nothing has to be disambiguated. Writes stay top-level
   * (`getConnectorAttachments().upload`), where a spine event and its consumers
   * have a transaction to live in.
   *
   * Gated by the target's `readPermission` checked against this connection's
   * `connection:<id>` grants. `null` for an id the scope does not know — a caller
   * falls back rather than failing a dispatch over a missing file.
   */
  openAttachment(attachmentId: string): Promise<OpenedAttachment | null>;
  /**
   * `openAttachment`, with the bytes as a stream that is never held whole (#2514), for a connector
   * that sends a file on to a provider. Gated the same way, before any byte is read. The sha256 is
   * checked as the bytes flow, and a mismatch errors the stream before its last chunk is handed on
   * (see {@link OpenedAttachmentStream}). The bytes delivered before a stream error are a prefix of
   * an unverified file, never a shorter file: a connector that sends what it read discards them and
   * undoes anything it wrote from them (an upload session cancelled, a request aborted before it
   * completes), as the hosted read's refusal says (`STREAMED_ATTACHMENT_UNVERIFIED` in
   * `@substrat-run/control-plane-api`). A stream it decides not to read is
   * cancelled (`body.stream.getReader().cancel()`), which releases the stored object at once.
   */
  openAttachmentStream(attachmentId: string): Promise<OpenedAttachmentStream | null>;
  /**
   * What this connection may do in the scope this delivery is for (#726 gap 1) —
   * `connectionGrantsInScope`, narrowed to this connection.
   *
   * Here so a connector can check its own preconditions at the top of a dispatch and
   * fail saying which grant is missing, instead of discovering it three calls later as
   * a refusal the drain then captions as the provider's (#841). A connector that needs
   * a standing grant for its RETURN path — where there is no delivered event to carry
   * authority — can say so on the way out, which is the only moment it is cheap to fix.
   *
   * Deliberately the permission keys and nothing else: a connector asks whether it may
   * act, never who granted it or when. Both are the operator's question, and both are
   * on the drawer that already renders them.
   */
  grants(): Promise<PermissionKey[]>;
  /**
   * Open a cell the scope sealed TO this connection (#687) — the egress half of
   * `ctx.sealToConnection`.
   *
   * **Here rather than on `ConnectorConnection`, and the probe path is why.** A
   * connection rebuilt top-level may have no directory row at all — the credential
   * probe builds one from a candidate secret and a zero id — so it holds no
   * keypair and could only ever throw. A sealed cell arrives on a delivered event,
   * which is to say inside a dispatch, which is exactly the shape that has one.
   *
   * **On the connection, for the same reason `fetch` and `openAttachment` are.**
   * The private half belongs to one connection, and the only connection it can
   * correctly be is the one this handler opened. An ambient `ctx.unseal` would
   * have to guess, and it would guess wrong the first time a tenant held two
   * credentials for one provider.
   *
   * Key material never crosses this seam: the adapter holds the keyId-indexed map
   * and picks by the cell's own `keyId`, so a connector cannot mislay a private
   * key it never had. Throws `SealedKeyUnavailableError` when the named key is not
   * held — which after a rotation-as-erasure (D-5) is the correct and permanent
   * answer, not a mystery. A scope restored from backup can resurrect a pending
   * request whose key is gone, and that delivery should dead-letter saying so.
   */
  unseal(sealed: SealedSecret): Promise<string>;
}

/** Tuning for one connector's egress. */
export interface ConnectorOptions extends ExecutorRetryPolicy {
  /**
   * Per-request timeout. Default 30s. It bounds the call up to the response headers and a
   * buffered read of the body. A streamed body (`ConnectorResponse.body`) is bounded by an idle
   * window instead (#2518, `STREAM_IDLE_TIMEOUT_MS`) and an absolute cap (`STREAM_MAX_DURATION_MS`):
   * it may take longer than this, as long as bytes keep arriving.
   */
  timeoutMs?: number;
  /**
   * The provider slug this connector operates (#574 phase 3) — the routing key a
   * CP-less host uses when it cannot run the handler itself: the delivery becomes a
   * `connector:<provider>` platform intent, and the platform's drain dispatches it to
   * the handler registered for that same slug. Defaults to the registration id, which
   * for the shipped connectors is already the provider name ('scrive'). Irrelevant on
   * a host that reaches the connection directory (self-host, the control plane): there
   * the handler runs in-process and this key is never consulted.
   */
  provider?: string;
}

/** A delivery that exhausted its attempts. The evidence, not a silent drop. */
export interface ExecutorDeadLetter {
  eventId: string;
  executorId: string;
  eventType: string;
  attempts: number;
  error: string;
  lastAttemptAt: string;
}

/**
 * Retry defaults (#100). Tuned for the directory write the first executor does;
 * a connector making an outbound call should raise `maxAttempts` explicitly,
 * which is why the policy is per-executor rather than a host constant.
 */
export function resolveRetryPolicy(retry?: ExecutorRetryPolicy): Required<ExecutorRetryPolicy> {
  return {
    maxAttempts: retry?.maxAttempts ?? 5,
    baseDelayMs: retry?.baseDelayMs ?? 1_000,
    maxDelayMs: retry?.maxDelayMs ?? 300_000,
  };
}

/**
 * When attempt `attempts` should next be tried: exponential, capped, jittered.
 *
 * Jitter is ±20% and is skipped entirely at zero delay, so a test setting
 * `baseDelayMs: 0` gets deterministic immediate retries rather than a race. It
 * matters at real delays because every scope in a fleet retries a downed
 * provider on the same schedule otherwise.
 */
export function backoffAt(
  attempts: number,
  retry: Required<ExecutorRetryPolicy>,
  from: Date,
): string {
  const raw = Math.min(retry.baseDelayMs * 2 ** (attempts - 1), retry.maxDelayMs);
  const jittered = raw === 0 ? 0 : raw * (0.8 + Math.random() * 0.4);
  return new Date(from.getTime() + jittered).toISOString();
}
