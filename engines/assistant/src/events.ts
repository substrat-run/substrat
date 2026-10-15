/**
 * engine-assistant's event contract (#696) — what a VERTICAL imports so that consuming this
 * engine by event is checked rather than guessed.
 *
 * Milestones only. The thread's own record is `assistant_events`; these are what the rest of
 * the platform learns about it. A text delta is not a platform event: forty of them make one
 * answer, and an outbox row each would be the record written twice.
 *
 * **No text and no tool data ride an event.** A message, a tool input and a tool output are
 * the person's data, and an event is the one copy an erasure cannot rewrite (K-37). So a
 * payload names the thread, the call and the tool, and carries the approval's digest (which
 * is a hash, not the input), never the approval's `preview` wording, which can restate what
 * the person asked for.
 *
 * VERTICAL-FACING ONLY. A sibling engine consuming one of these must NOT import it (R1,
 * star topology).
 *
 * Additive, like every other engine surface: a new event type may appear, an existing
 * payload field does not change shape without a `schemaVersion` bump.
 */
import type { DomainEventInput } from '@substrat-run/contracts';
import type { OperationContext } from '@substrat-run/kernel';

/** A thread was opened for a principal. */
export interface AssistantThreadCreatedPayload {
  threadId: string;
  /** The principal the thread belongs to. */
  subject: string;
}

/** The user said something and a turn began. */
export interface AssistantTurnStartedPayload {
  threadId: string;
}

/** A run came to rest on a turn: done, waiting for an approval, stopped, or out of budget. */
export interface AssistantTurnFinishedPayload {
  threadId: string;
  reason: 'done' | 'awaiting-approval' | 'stopped' | 'budget';
}

/** A gated tool call is waiting for the user, bound to `digest`. */
export interface AssistantApprovalRequestedPayload {
  threadId: string;
  callId: string;
  tool: string;
  /** SHA-256 of the canonical input the user was shown. */
  digest: string;
}

/** The user approved or denied a gated tool call. */
export interface AssistantApprovalResolvedPayload {
  threadId: string;
  callId: string;
  tool: string;
  approved: boolean;
}

/** The thread was closed; nothing more is appended. */
export interface AssistantThreadClosedPayload {
  threadId: string;
}

/**
 * engine-assistant's event contract — the six event types this engine emits and the payload
 * each one carries. Satisfies the kernel's `EventContract`.
 */
export type AssistantEvents = {
  events: {
    'assistant.thread-created': AssistantThreadCreatedPayload;
    'assistant.turn-started': AssistantTurnStartedPayload;
    'assistant.turn-finished': AssistantTurnFinishedPayload;
    'assistant.approval-requested': AssistantApprovalRequestedPayload;
    'assistant.approval-resolved': AssistantApprovalResolvedPayload;
    'assistant.thread-closed': AssistantThreadClosedPayload;
  };
};

/** Every event type this engine emits. */
export type AssistantEventType = keyof AssistantEvents['events'];

/**
 * Every event type this engine emits, and the `schemaVersion` each is emitted at — the ONE
 * home for that number (#1597). `emitAssistantEvent` stamps it and the manifest's `emits` is
 * derived from it, so the two cannot drift. Bumping a version is K-39's REPLACE.
 */
export const assistantEventVersions = {
  'assistant.thread-created': 1,
  'assistant.turn-started': 1,
  'assistant.turn-finished': 1,
  'assistant.approval-requested': 1,
  'assistant.approval-resolved': 1,
  'assistant.thread-closed': 1,
} as const satisfies Record<AssistantEventType, number>;

/** The manifest's `events.emits`, read off {@link assistantEventVersions} — never hand-declared. */
export const assistantEmitDeclarations: { type: string; schemaVersion: number }[] = Object.entries(
  assistantEventVersions,
).map(([type, schemaVersion]) => ({ type, schemaVersion }));

/**
 * `ctx.emit`, with the event type and its payload welded together, so the map above is the
 * source rather than a description nothing holds in agreement. Its one runtime act is
 * stamping `schemaVersion`.
 */
export function emitAssistantEvent<K extends AssistantEventType>(
  ctx: OperationContext,
  event: Omit<DomainEventInput, 'type' | 'payload' | 'schemaVersion'> & {
    type: K;
    payload: AssistantEvents['events'][K];
  },
): void {
  ctx.emit({ ...event, schemaVersion: assistantEventVersions[event.type] });
}
