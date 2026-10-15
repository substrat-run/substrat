/**
 * The published shapes and the declared inputs of engine-assistant, in one place so the
 * in-scope functions in `index.ts` and the declared operations in `operations.ts` read the
 * same definition rather than two that drift.
 *
 * Published shapes are camelCase projections; the stored rows (snake_case) are in
 * `entities.ts`. A caller never sees a row.
 */
import { assistantStreamBody, assistantStreamEvent, z } from '@substrat-run/contracts';

/** The longest an event body may serialise to. See `MAX_EVENT_BYTES` in `index.ts`. */
export const MAX_EVENT_BYTES = 64 * 1024;

const threadId = z.string().min(1).max(64);
const runId = z.string().min(1).max(64);
const callId = z.string().min(1).max(64);

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

export const sendMessageInput = z.object({ threadId, text: z.string().min(1).max(32_000) });
export type SendMessageInput = z.infer<typeof sendMessageInput>;
export const sentMessage = z.object({ firstSeq: z.number().int().positive(), lastSeq: z.number().int().positive() });
export type SentMessage = z.infer<typeof sentMessage>;

export const resolveApprovalInput = z.object({
  threadId,
  callId,
  /** The digest the user was shown (`approvalDigest` of the proposed input). */
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  approved: z.boolean(),
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
  /** The input the host is about to execute: it must hash to what the user approved. */
  input: z.unknown(),
});
export type ClaimExecutionInput = z.infer<typeof claimExecutionInput>;
export const claimedExecution = z.object({ claimed: z.literal(true) });
