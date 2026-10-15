/**
 * The published shapes and the declared inputs of engine-assistant, in one place so the
 * in-scope functions in `index.ts` and the declared operations in `operations.ts` read the
 * same definition rather than two that drift.
 *
 * Published shapes are camelCase projections; the stored rows (snake_case) are in
 * `entities.ts`. A caller never sees a row.
 */
import { z } from '@substrat-run/contracts';
import { assistantStreamBody, assistantStreamEvent } from '@substrat-run/contracts/assistant-stream';

/**
 * The longest an event body may serialise to, in UTF-8 bytes: the Durable Object row limit
 * is in bytes. A large tool result belongs in the operation that produced it, by id.
 */
export const MAX_EVENT_BYTES = 64 * 1024;

/**
 * The longest a user's message may be, in UTF-8 bytes of its text AS SERIALISED (escapes
 * included). Half the event bound, so a message that passes the input schema always fits in
 * its `user-message` event: a message is refused as a message, at the boundary, never as an
 * oversized event further in.
 */
export const MAX_MESSAGE_BYTES = 32 * 1024;

/** UTF-8 byte length of a string, without a platform encoder (module code has none in its types). */
export function utf8Length(s: string): number {
  let bytes = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

const threadId = z.string().min(1).max(64);
const runId = z.string().min(1).max(64);
const callId = z.string().min(1).max(64);
const deployedVersion = z.string().min(1).max(128);

/** One thread, projected. */
export const thread = z.object({
  id: z.string(),
  /** The principal the thread belongs to. */
  subject: z.string(),
  title: z.string().nullable(),
  status: z.enum(['open', 'closed']),
  createdAt: z.string(),
  lastEventAt: z.string(),
  closedAt: z.string().nullable(),
});
export type Thread = z.infer<typeof thread>;

export const createThreadInput = z.object({ title: z.string().max(200).optional() });
export type CreateThreadInput = z.infer<typeof createThreadInput>;

export const listThreadsInput = z.object({
  /** Another principal's threads: needs `assistant:audit`. Unset means the caller's own. */
  subject: z.string().min(1).optional(),
  status: z.enum(['open', 'closed']).optional(),
});
export type ListThreadsInput = z.infer<typeof listThreadsInput>;

export const threadIdInput = z.object({ threadId });
export type ThreadIdInput = z.infer<typeof threadIdInput>;

/** A bounded read of the record, by the cursor a client resumes after. */
export const readEventsInput = z.object({
  threadId,
  /** Events strictly after this `seq`. 0 reads from the start. */
  after: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(1000).default(500),
});
export type ReadEventsInput = z.input<typeof readEventsInput>;

export const eventsPage = z.object({
  events: z.array(assistantStreamEvent),
  /** The `seq` of the last event returned, or `after` when there were none. */
  lastSeq: z.number().int().nonnegative(),
});
export type EventsPage = z.infer<typeof eventsPage>;

export const sendMessageInput = z.object({
  threadId,
  // 32 000 characters is the stream protocol's own bound on `user-message`; the byte bound is
  // the engine's, and is what a message in a wide script meets first.
  text: z
    .string()
    .min(1)
    .max(32_000)
    .superRefine((text, ctx) => {
      const bytes = utf8Length(JSON.stringify(text));
      if (bytes > MAX_MESSAGE_BYTES) {
        ctx.addIssue({
          code: 'custom',
          message: `the message is ${bytes} bytes; a message may be at most ${MAX_MESSAGE_BYTES} bytes — send it in shorter parts`,
        });
      }
    }),
});
export type SendMessageInput = z.infer<typeof sendMessageInput>;
export const sentMessage = z.object({ firstSeq: z.number().int().positive(), lastSeq: z.number().int().positive() });
export type SentMessage = z.infer<typeof sentMessage>;

export const resolveApprovalInput = z.object({
  threadId,
  callId,
  /** The digest the user was shown: the request's `digest`. */
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  approved: z.boolean(),
  /**
   * The deployed version the answer arrives under, as the HOST knows it (never the client):
   * an approval given under another version than the request was made under is refused.
   */
  version: deployedVersion,
});
export type ResolveApprovalInput = z.infer<typeof resolveApprovalInput>;
export const resolvedApproval = z.object({ seq: z.number().int().positive() });

export const acquireRunInput = z.object({
  threadId,
  runId,
  /** A holder that has not beaten for this long may be replaced. Default 15 s. */
  staleMs: z.number().int().min(500).max(600_000).optional(),
});
export type AcquireRunInput = z.infer<typeof acquireRunInput>;
export const acquiredRun = z.object({ tookOver: z.boolean() });

export const releaseRunInput = z.object({ threadId, runId });
export type ReleaseRunInput = z.infer<typeof releaseRunInput>;
export const releasedRun = z.object({ released: z.boolean() });

export const appendEventsInput = z.object({
  threadId,
  runId,
  events: z.array(assistantStreamBody).min(1).max(200),
});
export type AppendEventsInput = z.input<typeof appendEventsInput>;
export const appendedEvents = z.object({ events: z.array(assistantStreamEvent) });
export type AppendedEvents = z.infer<typeof appendedEvents>;

export const claimExecutionInput = z.object({
  threadId,
  runId,
  callId,
  /** The operation the host is about to run: it must be the one the user approved. */
  operation: z.string().min(1).max(128),
  /** The deployed version the host runs it under: it must be the one the request was made under. */
  version: deployedVersion,
  /** The input the host is about to execute: it must hash to what the user approved. */
  input: z.unknown(),
});
export type ClaimExecutionInput = z.infer<typeof claimExecutionInput>;
export const claimedExecution = z.object({ claimed: z.literal(true) });
