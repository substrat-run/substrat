import { z } from 'zod';
import { instant, principalId } from './ids.js';

// The assistant's stream protocol (docs/rfc/assistant.md §5.1, #2283): the events a thread
// is made of, in the order a client folds them into a conversation.
//
// **Experimental.** Published only at the subpath `@substrat-run/contracts/assistant-stream`
// and kept out of the package root until the RFC (#2284) settles the actor model and a
// product consumes it. The names may still change, and they change here without a version
// bump until the root exports it.
//
// The vocabulary is shaped like the AI SDK's UI message parts on purpose — text and tool
// calls as start / delta / end or input / output, an approval request as a state a tool call
// passes through — so a mapping to and from that format is mechanical. It is OWNED here,
// not imported from it: the element and every client are published, and must not break when
// a library ships a major version with a different wire format.
//
// Three properties the rest of the design leans on:
//
//   1. `id` belongs to the RECORD, never to the producer. An event is written first and
//      delivered second, and `id` is what the record assigned it — a strictly increasing
//      integer per thread, and the cursor a client resumes after (`Last-Event-ID`). So an
//      event has two shapes: the body a producer emits, and the event a client receives.
//   2. A turn is resumable from its events alone. A step that was cut off is restarted from
//      its beginning, announced by `step-restart`, so a client drops the partial text of
//      that step instead of showing it twice.
//   3. Additive only, and a client READS through `readAssistantStreamEvent`, not the strict
//      schema. That reader hands back an event type it does not know, and a known type
//      carrying an enum value it does not know, as `{ known: false }` rather than throwing,
//      so a new event type, a new enum value or a new optional field is not a break. A
//      removal, a rename or a retype is `ASSISTANT_STREAM_VERSION` plus one, and so is changing
//      a size bound: a reader at this version throws on a value over its bound (`too_big`),
//      so raising one is not additive. A stream says which version it speaks on `turn-start`.

/** The version of this vocabulary. A change that is not additive bumps it. */
export const ASSISTANT_STREAM_VERSION = 1;

/** Names a text part within a turn, so deltas find their part. */
const partId = z.string().min(1).max(64);
/** Names a tool call within a turn, so its input, approval and output find each other. */
const callId = z.string().min(1).max(64);
/** What the step is called in the loop (`lookup`, `propose`, …). Opaque to a client. */
const stepName = z.string().min(1).max(64);
/** A tool as the model knows it. Not an operation name: the host maps one to the other. */
const toolName = z.string().min(1).max(128);
/** The deployed version a request was made under. Opaque: whatever the host's version identity is. */
const deployedVersion = z.string().min(1).max(128);
/** The operation a tool call runs as (`todo/archive`). What an approval is for. */
const operationName = z.string().min(1).max(128);
/**
 * A single-use value minted per approval request, so two requests for the same call and the
 * same input still digest differently and an old approval never fits a new request.
 */
export const approvalNonce = z.string().regex(/^[0-9A-Za-z_-]{16,64}$/);

/** The longest text delta. A producer splits a longer run of text into several. */
export const ASSISTANT_TEXT_DELTA_MAX = 16_000;
/** The largest serialized tool input, in UTF-8 bytes. Inputs are arguments, not documents. */
export const ASSISTANT_TOOL_INPUT_MAX_BYTES = 16 * 1024;
/**
 * The largest serialized tool output, in UTF-8 bytes. Every event is a row in the record and
 * a Durable Object row has a hard ceiling, so a larger result goes by `ref` (§5.2: the
 * record keeps a reference, not a copy).
 */
export const ASSISTANT_TOOL_OUTPUT_MAX_BYTES = 32 * 1024;

/** A value JSON can carry, at most `maxBytes` once serialized. */
function boundedJson(maxBytes: number) {
  return z.unknown().superRefine((value, ctx) => {
    let text: string | undefined;
    try {
      text = JSON.stringify(value);
    } catch {
      text = undefined;
    }
    if (text === undefined) {
      ctx.addIssue({ code: 'custom', message: 'must be a value JSON can carry' });
      return;
    }
    const bytes = new TextEncoder().encode(text).length;
    if (bytes > maxBytes) {
      ctx.addIssue({ code: 'custom', message: `is ${bytes} bytes serialized; at most ${maxBytes}` });
    }
  });
}

/** A link a client may render: `http:` or `https:` only, never `javascript:` or `data:`. */
const httpUrl = z
  .string()
  .max(2_000)
  .refine((s) => {
    try {
      const { protocol } = new URL(s);
      return protocol === 'http:' || protocol === 'https:';
    } catch {
      return false;
    }
  }, 'must be an http(s) URL');

/**
 * The digest an approval binds to: lower-case hex SHA-256 (`approvalDigest`). 64
 * characters, so a client cannot send a short one.
 */
export const approvalDigestString = z.string().regex(/^[0-9a-f]{64}$/);

/** Why a turn came to rest. `awaiting-approval` is a pause, not an end. */
export const turnFinishReason = z.enum(['done', 'awaiting-approval', 'stopped', 'budget']);
export type TurnFinishReason = z.infer<typeof turnFinishReason>;

const text = z.object({ pid: partId });

/** Files travel through blob storage; a message keeps only their immutable identity. */
export const ASSISTANT_MESSAGE_FILES_MAX = 5;
export const assistantMessageFile = z.object({
  id: z.string().min(1).max(64),
  filename: z.string().min(1).max(512),
  contentType: z.string().min(1).max(255),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type AssistantMessageFile = z.infer<typeof assistantMessageFile>;

/**
 * Every event a producer can emit, without its `id`. Discriminated on `t`. Strict: a
 * producer and the record parse with this; a client reads with `readAssistantStreamEvent`.
 */
export const assistantStreamBody = z.discriminatedUnion('t', [
  // The user's side of a turn, and the start of the turn it opens. `v` is the
  // `ASSISTANT_STREAM_VERSION` the producer speaks, so a client can tell a stream it cannot
  // read from one it can.
  z.object({
    t: z.literal('user-message'),
    text: z.string().max(32_000),
    files: z.array(assistantMessageFile).min(1).max(ASSISTANT_MESSAGE_FILES_MAX).optional(),
  }),
  z.object({ t: z.literal('turn-start'), v: z.number().int().positive() }),
  // Rest. `awaiting-approval` ends the run, not the turn: an approval resumes it.
  z.object({ t: z.literal('turn-finish'), reason: turnFinishReason }),
  // A failure the turn ends on. `code` is a stable slug a client branches on, `message` is
  // for the user, in their language, and never a stack trace.
  z.object({ t: z.literal('turn-error'), code: z.string().min(1).max(64), message: z.string().max(2_000) }),

  // Step boundaries. `step-restart` names the step that was cut off and is starting over.
  z.object({ t: z.literal('step-start'), step: stepName }),
  z.object({ t: z.literal('step-end'), step: stepName }),
  z.object({ t: z.literal('step-restart'), step: stepName }),

  // Text, as start / delta / end. Neighbouring deltas of one part may be merged by the
  // record (up to the bound), so a client must not assume one delta per token.
  text.extend({ t: z.literal('text-start') }),
  text.extend({ t: z.literal('text-delta'), delta: z.string().max(ASSISTANT_TEXT_DELTA_MAX) }),
  text.extend({ t: z.literal('text-end') }),

  // A tool call: its input, then its output or its error. A result too large for a row
  // travels as `ref` (what the product resolves it by) with `output` absent or a summary.
  z.object({ t: z.literal('tool-input'), callId, tool: toolName, input: boundedJson(ASSISTANT_TOOL_INPUT_MAX_BYTES) }),
  z.object({
    t: z.literal('tool-output'),
    callId,
    tool: toolName,
    output: boundedJson(ASSISTANT_TOOL_OUTPUT_MAX_BYTES).optional(),
    ref: z.string().min(1).max(500).optional(),
  }),
  z.object({ t: z.literal('tool-error'), callId, tool: toolName, message: z.string().max(2_000) }),

  // A gated write waiting for the user. `preview` is the product's own wording of what will
  // change, never the model's prose. `digest` is `approvalDigest` over this request's
  // bindings plus the thread and its subject (the approver), which the record knows.
  // `version` is the deployed version the request was made under: the operation and its
  // preview may change in a deploy while a request waits, and the user approved what THIS
  // version showed, so an answer arriving under another version is refused.
  z.object({
    t: z.literal('approval-request'),
    callId,
    step: stepName,
    tool: toolName,
    operation: operationName,
    version: deployedVersion,
    input: boundedJson(ASSISTANT_TOOL_INPUT_MAX_BYTES),
    expiresAt: instant,
    nonce: approvalNonce,
    digest: approvalDigestString,
    preview: z.string().max(2_000),
  }),
  // The user's answer. `approver` is who answered, as the host authenticated them on this
  // message; `digest` echoes the request it answers, so the record shows what was agreed to.
  z.object({
    t: z.literal('approval-resolved'),
    callId,
    approved: z.boolean(),
    approver: principalId,
    digest: approvalDigestString,
  }),

  // Where an answer came from. `ref` is whatever the product links to (an entity, a page).
  z.object({
    t: z.literal('source'),
    sid: z.string().min(1).max(64),
    title: z.string().max(500),
    url: httpUrl.optional(),
    ref: z.string().max(500).optional(),
  }),

  // The AI marker and its provenance: when, which model, how many sources, and (for staff
  // only; the host withholds it from anyone else) the query it ran.
  z.object({
    t: z.literal('data-provenance'),
    producedAt: instant,
    model: z.string().max(200).optional(),
    sources: z.number().int().nonnegative().optional(),
    query: z.string().max(4_000).optional(),
  }),

  // A limit reached, or about to be. Always carries enough for the UI to say what happens next.
  z.object({
    t: z.literal('budget-notice'),
    exhausted: z.boolean(),
    resetsAt: instant.optional(),
  }),
]);
export type AssistantStreamBody = z.infer<typeof assistantStreamBody>;

/** The event type literals, for exhaustive handling on a client. */
export type AssistantStreamEventType = AssistantStreamBody['t'];

const eventId = z.number().int().positive();

/**
 * An event as a client receives it: the body plus the id the record gave it. Integers
 * strictly increase per thread and are the resume cursor.
 */
export const assistantStreamEvent = z.intersection(assistantStreamBody, z.object({ id: eventId }));
export type AssistantStreamEvent = z.infer<typeof assistantStreamEvent>;

const KNOWN_TYPES: ReadonlySet<string> = new Set(assistantStreamBody.options.map((o) => o.shape.t.value));

/** What `readAssistantStreamEvent` hands a client. */
export type ReadAssistantStreamEvent =
  | { known: true; event: AssistantStreamEvent }
  | { known: false; t: string; id: number; raw: Record<string, unknown> };

/**
 * How a CLIENT reads an event: forward-compatible where the strict schema is not.
 *
 * - A `t` this version does not know, or a known `t` whose only fault is an enum value this
 *   version does not know (a new `turn-finish` reason), is `{ known: false }` with its `id`,
 *   so the client still advances its resume cursor and skips it, rather than throwing on the
 *   first additive event.
 * - Anything else that does not parse throws: a known event missing a field, or a value of
 *   the wrong type (an enum field that is absent, a number or `null` included), is a broken
 *   producer, not a newer one.
 * - No `t`, or no valid `id`, throws too: without them the event cannot even be skipped.
 */
export function readAssistantStreamEvent(raw: unknown): ReadAssistantStreamEvent {
  const envelope = z.looseObject({ t: z.string().min(1), id: eventId }).parse(raw);
  const record = raw as Record<string, unknown>;
  if (!KNOWN_TYPES.has(envelope.t)) return { known: false, t: envelope.t, id: envelope.id, raw: record };
  const parsed = assistantStreamEvent.safeParse(raw);
  if (parsed.success) return { known: true, event: parsed.data };
  // Zod says `invalid_value` for an enum whatever it was handed, so only a present string
  // counts as a value from a newer version; a missing one, a number or a null is broken.
  if (parsed.error.issues.every((issue) => issue.code === 'invalid_value' && typeof valueAt(raw, issue.path) === 'string')) {
    return { known: false, t: envelope.t, id: envelope.id, raw: record };
  }
  throw parsed.error;
}

function valueAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let at = root;
  for (const key of path) {
    if (at === null || typeof at !== 'object' || !Object.hasOwn(at, key)) return undefined;
    at = (at as Record<PropertyKey, unknown>)[key];
  }
  return at;
}

/** The events a turn can come to rest on. A stream that ends on one needs no resume. */
export const ASSISTANT_RESTING_EVENTS: ReadonlySet<AssistantStreamEventType> = new Set(['turn-finish', 'turn-error']);

/** True when `event` ends a run: nothing further will arrive until someone acts. */
export function isRestingEvent(event: { t: string }): boolean {
  return (ASSISTANT_RESTING_EVENTS as ReadonlySet<string>).has(event.t);
}

// ── The approval digest ─────────────────────────────────────────────────────────────────

/** The tag that opens every approval tuple. A new tuple shape is a new tag, never an edit. */
export const APPROVAL_DIGEST_TAG = 'substrat.approval/v1';

/**
 * Everything an approval is bound to. `version` is the deployed version the request was made
 * under, `approver` is the principal who may say yes (the
 * thread's subject), `thread` the thread, `step` and `call` the step and tool call it belongs
 * to, `operation` what will run, `input` its parsed input, `expiresAt` when the request lapses
 * and `nonce` a value minted for this one request.
 */
export const approvalBinding = z.object({
  version: deployedVersion,
  approver: principalId,
  thread: z.string().min(1).max(64),
  step: stepName,
  call: callId,
  operation: operationName,
  // The event's own `instant` rule, and only in `toISOString()`'s form, so one moment has one
  // digest and an expiry the event would refuse cannot be digested.
  expiresAt: z.string().refine((s) => {
    const parsed = instant.safeParse(s);
    return parsed.success && parsed.data === s;
  }, 'must be an instant as toISOString() writes it'),
  nonce: approvalNonce,
  input: z.unknown(),
});
export type ApprovalBinding = z.input<typeof approvalBinding>;

/**
 * The encoding the approval digest hashes. Its OWN, deliberately not `canonicalJson`: an
 * idempotency fingerprint may change its encoding between deploys, and an approval digest
 * may not — digests are stored and compared across deploys, so a change here invalidates
 * every pending approval. The test pins vectors for it.
 *
 * A subset of JSON with one spelling per value:
 * - object keys sorted by UTF-16 code unit; a member whose value is `undefined` is left out,
 *   so an unset optional and one set to `undefined` agree;
 * - strings as `JSON.stringify` writes them (a lone surrogate escaped, never replaced);
 * - numbers as `Number#toString` writes them (`0.1`, `1e+21`), finite only, `-0` as `0`;
 * - arrays in order.
 *
 * It THROWS on anything else — `undefined` outside an object member (an array hole included), a symbol key, a
 * non-enumerable property, a named property on an array, `NaN`, `±Infinity`, a
 * bigint, a function, a symbol, a `Date`, `Map`, `Set` or any other non-plain object, and a
 * cycle — rather than collapse two different values into one spelling, as JSON does.
 */
export function approvalEncoding(value: unknown): string {
  return encode(value, new Set());
}

function encode(value: unknown, path: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`approvalEncoding: ${value} has no encoding`);
      return String(value); // `String(-0)` is '0'
    case 'object':
      break;
    default:
      throw new TypeError(`approvalEncoding: a ${typeof value} has no encoding`);
  }
  const object = value as object;
  if (path.has(object)) throw new TypeError('approvalEncoding: a cycle has no encoding');
  path.add(object);
  try {
    // What `Object.keys` cannot see (a symbol key, a non-enumerable property, a named
    // property on an array) is refused, not dropped: dropping it would give two values one
    // spelling. An array owns its indices and `length`, and nothing else (a hole, one fewer,
    // is refused below as the `undefined` it reads as).
    const own = Reflect.ownKeys(object).length;
    if (Array.isArray(object) ? own > object.length + 1 : own !== Object.keys(object).length) {
      throw new TypeError('approvalEncoding: a property JSON cannot see has no encoding');
    }
    if (Array.isArray(object)) {
      // `Array.from` reads a hole as `undefined`, which is refused like any other.
      return `[${Array.from(object, (entry) => encode(entry, path)).join(',')}]`;
    }
    const proto = Object.getPrototypeOf(object);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(`approvalEncoding: a ${proto?.constructor?.name ?? 'non-plain object'} has no encoding`);
    }
    const members = Object.entries(object)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${encode(v, path)}`);
    return `{${members.join(',')}}`;
  } finally {
    path.delete(object);
  }
}

/**
 * The digest an approval is bound to: SHA-256 over `approvalEncoding` of the tagged tuple
 * `['substrat.approval/v1', version, approver, thread, step, call, operation, expiresAt, nonce, input]`,
 * as 64 lower-case hex characters. Web Crypto, so it is the same function on the host, in a
 * test and in a browser.
 *
 * The engine stores the digest of the request it showed and, when an answer arrives,
 * recomputes it with the principal who ANSWERED as `approver`. So an approval from anyone
 * but the thread's subject, for another thread, step, call or operation, or for an input the
 * model changed afterwards, or under another deployed version, does not match. Same-looking calls never share a digest: one
 * `{ id }` archived and deleted, or one call in two threads, digest differently.
 *
 * What the digest does NOT do, and the engine must: refuse an answer after `expiresAt`
 * (the digest binds the expiry, it cannot read a clock), and accept each request once (the
 * nonce makes requests distinct; single use is the record's conditional append, not a read
 * before it). The answer must also arrive on a user-presence route the loop cannot call.
 *
 * Throws when a binding is malformed or the input holds a value `approvalEncoding` refuses.
 */
export async function approvalDigest(binding: ApprovalBinding): Promise<string> {
  const b = approvalBinding.parse(binding);
  const tuple = [APPROVAL_DIGEST_TAG, b.version, b.approver, b.thread, b.step, b.call, b.operation, b.expiresAt, b.nonce, b.input];
  const bytes = new TextEncoder().encode(approvalEncoding(tuple));
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
