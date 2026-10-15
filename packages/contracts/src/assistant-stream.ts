import { z } from 'zod';
import { instant } from './ids.js';
import { canonicalJson } from './idempotency.js';

// The assistant's stream protocol (docs/rfc/assistant.md §5.1, #2283): the events a thread
// is made of, in the order a client folds them into a conversation.
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
//   3. Additive only. A client ignores a `t` it does not know and a field it does not
//      read, so a new event type or an optional field is not a break. A removal, a rename
//      or a retype is `ASSISTANT_STREAM_VERSION` plus one.

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

/**
 * The digest an approval binds to: lower-case hex SHA-256 of the canonical JSON of the
 * proposed input (`approvalDigest`). 64 characters, so a client cannot send a short one.
 */
export const approvalDigestString = z.string().regex(/^[0-9a-f]{64}$/);

/** Why a turn came to rest. `awaiting-approval` is a pause, not an end. */
export const turnFinishReason = z.enum(['done', 'awaiting-approval', 'stopped', 'budget']);
export type TurnFinishReason = z.infer<typeof turnFinishReason>;

const text = z.object({ pid: partId });

/**
 * Every event a producer can emit, without its `id`. Discriminated on `t`.
 */
export const assistantStreamBody = z.discriminatedUnion('t', [
  // The user's side of a turn, and the start of the turn it opens.
  z.object({ t: z.literal('user-message'), text: z.string().max(32_000) }),
  z.object({ t: z.literal('turn-start') }),
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
  // record, so a client must not assume one delta per token.
  text.extend({ t: z.literal('text-start') }),
  text.extend({ t: z.literal('text-delta'), delta: z.string() }),
  text.extend({ t: z.literal('text-end') }),

  // A tool call: its input, then its output or its error. The host runs it as the signed-in
  // user, so a refusal is an error the model reads, not a broken session.
  z.object({ t: z.literal('tool-input'), callId, tool: toolName, input: z.unknown() }),
  z.object({ t: z.literal('tool-output'), callId, tool: toolName, output: z.unknown() }),
  z.object({ t: z.literal('tool-error'), callId, tool: toolName, message: z.string().max(2_000) }),

  // A gated write waiting for the user. `preview` is the product's own wording of what will
  // change, never the model's prose. `digest` binds the approval to `input`.
  z.object({
    t: z.literal('approval-request'),
    callId,
    tool: toolName,
    input: z.unknown(),
    digest: approvalDigestString,
    preview: z.string().max(2_000),
  }),
  z.object({ t: z.literal('approval-resolved'), callId, approved: z.boolean() }),

  // Where an answer came from. `ref` is whatever the product links to (an entity, a page).
  z.object({
    t: z.literal('source'),
    sid: z.string().min(1).max(64),
    title: z.string().max(500),
    url: z.string().max(2_000).optional(),
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

/**
 * An event as a client receives it: the body plus the id the record gave it. Integers
 * strictly increase per thread and are the resume cursor.
 */
export const assistantStreamEvent = z.intersection(assistantStreamBody, z.object({ id: z.number().int().positive() }));
export type AssistantStreamEvent = z.infer<typeof assistantStreamEvent>;

/** The events a turn can come to rest on. A stream that ends on one needs no resume. */
export const ASSISTANT_RESTING_EVENTS: ReadonlySet<AssistantStreamEventType> = new Set(['turn-finish', 'turn-error']);

/** True when `event` ends a run: nothing further will arrive until someone acts. */
export function isRestingEvent(event: { t: string }): boolean {
  return (ASSISTANT_RESTING_EVENTS as ReadonlySet<string>).has(event.t);
}

/**
 * The digest an approval is bound to. The engine stores the digest of the input it was
 * shown; an approval that arrives with a different one is refused, so the model cannot
 * change the arguments after the user said yes. Web Crypto, so it is the same function on
 * the host, in a test and in a browser.
 *
 * Over `canonicalJson` (the one idempotency fingerprints use), so key order never changes
 * the digest and an unset optional agrees with one set to `undefined`. The input is the
 * PARSED input of the operation, as for a fingerprint, so a value JSON cannot carry has
 * already been refused by its schema before it gets here.
 */
export async function approvalDigest(input: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(input));
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
