/**
 * The assistant engine's declared operation surface.
 *
 * Two audiences, and the line between them is the point of the engine.
 *
 * **A person** (`assistant:use`) opens threads, reads their own, says something, approves or
 * denies what the assistant proposes, and closes a thread. Every one of those acts on the
 * caller's own threads: none takes a principal as input to act as, so holding the key never
 * reaches anybody else's conversation. `assistant:audit` adds reading another principal's
 * threads, never writing to them.
 *
 * **The assistant host** (`assistant:run`) takes the lease on a thread, appends what the
 * assistant said and did, and claims a gated tool's execution. This key is held by the
 * host's principal ONLY and by no role a person has. If a person held it they could append
 * `text-delta` events to their own thread and have the record say the assistant wrote them,
 * or mark a tool call done that never ran. The split is what makes the record evidence.
 *
 * Node checks only: a thread is its owner's, which is a comparison of principals the
 * handlers make, not a per-entity grant somebody else could hold. No `http`: an engine owns
 * no URL shape; a composing vertical binds these with `defineEngineRoutes`.
 */
import { defineOperations } from '@substrat-run/contracts';
import { assistantEntities } from './entities.js';
import {
  acquireRunInput,
  acquiredRun,
  appendEventsInput,
  appendedEvents,
  claimExecutionInput,
  claimedExecution,
  createThreadInput,
  eventsPage,
  listThreadsInput,
  readEventsInput,
  releaseRunInput,
  releasedRun,
  resolveApprovalInput,
  resolvedApproval,
  sendMessageInput,
  sentMessage,
  thread,
  threadIdInput,
} from './shapes.js';

/** The keys these operations check. Mirrors `ASSISTANT_PERM` in index.ts. */
export const ASSISTANT_PERMISSIONS = ['assistant:use', 'assistant:audit', 'assistant:run'] as const;

export const assistantOperations = defineOperations(assistantEntities, ASSISTANT_PERMISSIONS)({
  'assistant/create-thread': {
    summary: 'Open a thread for the caller',
    permission: 'assistant:use',
    input: createThreadInput,
    inputOptional: true,
    output: thread,
  },

  'assistant/list-threads': {
    summary: "The caller's threads, most recently active first (another principal's, with audit)",
    permission: 'assistant:use',
    input: listThreadsInput,
    inputOptional: true,
    output: thread,
    // Handler-composed: a thread is a projection of its row, and the read narrows to the
    // caller's own before it pages. The order and the cursor are (last_event_at, id).
    paged: { sortKey: 'lastEventAt' },
  },

  'assistant/get-thread': {
    summary: 'One thread',
    permission: 'assistant:use',
    input: threadIdInput,
    output: thread,
  },

  'assistant/read-events': {
    summary: "A thread's events after a cursor — how a client resumes",
    permission: 'assistant:use',
    input: readEventsInput,
    output: eventsPage,
  },

  'assistant/send-message': {
    summary: 'Send text or uploaded files in a thread, which begins a turn',
    permission: 'assistant:use',
    input: sendMessageInput,
    output: sentMessage,
  },

  'assistant/authorize-file-upload': {
    summary: 'Authorize a host to upload a file to the caller’s own open thread',
    permission: 'assistant:use',
    input: threadIdInput,
    output: thread,
  },

  'assistant/resolve-approval': {
    summary: 'Approve or deny a gated tool call, bound to the input shown',
    permission: 'assistant:use',
    input: resolveApprovalInput,
    output: resolvedApproval,
  },

  'assistant/close-thread': {
    summary: 'Close a thread; nothing more is appended',
    permission: 'assistant:use',
    input: threadIdInput,
    output: thread,
  },

  'assistant/acquire-run': {
    summary: 'Take the single-writer lease on a thread (host only)',
    permission: 'assistant:run',
    input: acquireRunInput,
    output: acquiredRun,
  },

  'assistant/release-run': {
    summary: 'Give the lease back when a run comes to rest (host only)',
    permission: 'assistant:run',
    input: releaseRunInput,
    output: releasedRun,
  },

  'assistant/append-events': {
    summary: "Append the assistant's events to a thread, fenced by the lease (host only)",
    permission: 'assistant:run',
    input: appendEventsInput,
    output: appendedEvents,
  },

  'assistant/claim-execution': {
    summary: 'Claim the one execution of an approved tool call (host only)',
    permission: 'assistant:run',
    input: claimExecutionInput,
    output: claimedExecution,
  },
});
