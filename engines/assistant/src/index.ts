/**
 * engine-assistant — composed **by call**, not by event.
 *
 * The record of a chat between a person and an assistant. It owns the invariants of that
 * record and nothing about the model that speaks for it: it never talks to a model, a
 * network or a clock of its own. A host (the platform's assistant host, or a vertical that
 * composes it) runs the loop, and calls these functions to write what happened.
 *
 * What the engine guarantees, each of which a test pins:
 *
 *   1. **The record is append-only and numbered.** Events are rows `(thread, seq)`, `seq`
 *      from 1, never updated or removed. `seq` is the cursor a client resumes after.
 *   2. **Only the lease holder writes the assistant's side.** `acquireRun` takes a
 *      single-writer lease; `appendEvents` is fenced by it, so a holder that was replaced
 *      while still running (a zombie) cannot write. A holder that stopped beating can be
 *      replaced.
 *   3. **A gated tool runs once, with the input the user saw.** A tool call that asks for
 *      approval is bound to `approvalDigest` of the tagged tuple (deployed version, approver,
 *      thread, step, call, operation, expiry, nonce, input; docs/rfc/assistant.md §6.0 point
 *      3), and the bindings are stored beside it. `resolveApproval` RECOMPUTES that digest
 *      with the principal who answered and the version the answer arrived under, so an
 *      approval from anyone but the thread's subject, for another thread, call or operation,
 *      under another deploy, or after the expiry, does not match. `claimExecution` recomputes
 *      it with the operation and input the host is about to run, before the expiry. Both
 *      moves are conditional writes (`… WHERE state = ? AND digest = ?`, one row changed or
 *      refused), so single use is the record's own, not a read that came before it. A
 *      `tool-output` for a gated call is refused unless it was claimed. The model cannot
 *      change the arguments after the user said yes.
 *   4. **The two sides of the record are written by different keys.** What the user did
 *      (`user-message`, `turn-start`, `approval-resolved`) is written by `sendMessage` and
 *      `resolveApproval` under `assistant:use`, as the owner. What the assistant did is
 *      written by `appendEvents` under `assistant:run`, which is held by a SYSTEM principal
 *      (the assistant host's) and by no role a person has — `lint:permissions` refuses a
 *      role or entity grant shape that grants it (tools/reserved-keys.mts). Even the run key writes only
 *      inside a turn the user opened: with no turn open, `appendEvents` is `no_turn_open`,
 *      so a run cannot keep a resting thread busy and lock its owner out.
 *   5. **An event is bounded.** A body over `MAX_EVENT_BYTES` is refused: a large tool
 *      result belongs in the operation that produced it, referred to by id, not copied into
 *      a Durable Object row.
 *
 * `appendEvents` and the per-delta rows do not emit a platform event each. Forty text deltas
 * make one answer, and an outbox row apiece would be the record written twice. The platform
 * learns the milestones (`events.ts`).
 *
 * Deferred, and stated so an absence reads as intent: message branches (regenerate, edit and
 * resend), participants other than the owner and the assistant (a human agent), the support
 * handoff, and memory. Each is additive: a column, an event type, a table.
 */
import { z } from 'zod';
import {
  CURSOR_FIELD_SEPARATOR,
  moduleManifest,
  pageOverFold,
  permissionKey,
  subjectErasureOf,
  substratError,
  type ListPage,
  type Page,
} from '@substrat-run/contracts';
import {
  ASSISTANT_STREAM_VERSION,
  approvalDigest,
  assistantStreamBody,
  isRestingEvent,
  type ApprovalBinding,
  type AssistantStreamBody,
  type AssistantStreamEvent,
} from '@substrat-run/contracts/assistant-stream';
import {
  assertAllowed,
  operationsFor,
  ulid,
  type ModuleRegistration,
  type OperationContext,
} from '@substrat-run/kernel';
import { assistantEntities, eventRow, runRow, threadRow, toolCallRow } from './entities.js';
import { emitAssistantEvent, assistantEmitDeclarations } from './events.js';
import { assistantOperations } from './operations.js';
import { columnsOf, returns } from './seam.js';
import {
  MAX_EVENT_BYTES,
  acquireRunInput,
  appendEventsInput,
  claimExecutionInput,
  createThreadInput,
  listThreadsInput,
  readEventsInput,
  releaseRunInput,
  resolveApprovalInput,
  sendMessageInput,
  thread as threadShape,
  threadIdInput,
  type AcquireRunInput,
  type AppendEventsInput,
  type AppendedEvents,
  type ClaimExecutionInput,
  type CreateThreadInput,
  type EventsPage,
  type ListThreadsInput,
  type ReadEventsInput,
  type ReleaseRunInput,
  type ResolveApprovalInput,
  type SendMessageInput,
  type SentMessage,
  type Thread,
  type ThreadIdInput,
  utf8Length,
} from './shapes.js';

export { MAX_EVENT_BYTES, MAX_MESSAGE_BYTES } from './shapes.js';
export type {
  AcquireRunInput,
  AppendEventsInput,
  AppendedEvents,
  ClaimExecutionInput,
  CreateThreadInput,
  EventsPage,
  ListThreadsInput,
  ReadEventsInput,
  ReleaseRunInput,
  ResolveApprovalInput,
  SendMessageInput,
  SentMessage,
  Thread,
  ThreadIdInput,
} from './shapes.js';
export { assistantEntities, threadRow, eventRow, runRow, toolCallRow } from './entities.js';
export { assistantOperations, ASSISTANT_PERMISSIONS } from './operations.js';
export {
  type AssistantEvents,
  type AssistantEventType,
  type AssistantThreadCreatedPayload,
  type AssistantTurnStartedPayload,
  type AssistantTurnFinishedPayload,
  type AssistantApprovalRequestedPayload,
  type AssistantApprovalResolvedPayload,
  type AssistantThreadClosedPayload,
} from './events.js';

/**
 * The conflict reasons this engine raises, narrowing the platform's `conflict` code (#113).
 * Additive only: new reasons may appear, existing ones do not change spelling.
 */
export const ASSISTANT_CONFLICT_REASONS = [
  'thread_closed',
  'turn_in_progress',
  'approval_pending',
  'no_approval_pending',
  'run_in_progress',
  'run_fenced',
  'not_a_run_event',
  'call_state',
  'approval_required',
  'approval_denied',
  'execution_not_claimed',
  'already_executed',
  'already_resolved',
  'digest_mismatch',
  'approval_expired',
  'no_turn_open',
] as const;
export type AssistantConflictReason = (typeof ASSISTANT_CONFLICT_REASONS)[number];

const conflict = (reason: AssistantConflictReason, message: string) =>
  substratError('conflict', message, { reason });

export const ASSISTANT_PERM = {
  use: permissionKey.parse('assistant:use'),
  audit: permissionKey.parse('assistant:audit'),
  run: permissionKey.parse('assistant:run'),
};

export const assistantManifest = moduleManifest.parse({
  id: '@substrat-run/engine-assistant',
  // Versions the manifest SHAPE, not the package (#976), and read by `src/model.ts`.
  version: '0.0.1',
  kernelContract: '^0.0.1',
  permissions: [
    {
      key: 'assistant:use',
      description: "Open threads, read your own, send messages and approve or deny the assistant's proposals",
    },
    {
      key: 'assistant:audit',
      description: "Read other principals' threads (never write to them). Only together with assistant:use, which every read checks first",
    },
    {
      key: 'assistant:run',
      description:
        "Drive a run: take the lease, append the assistant's events, claim a tool's execution. For a system principal (the assistant host's) only — never a role a person holds",
    },
  ],
  events: { emits: assistantEmitDeclarations, consumes: [] },
  migrations: { journalDir: './migrations', compatibleFrom: '0.0.1' },
  attachmentTargets: [],
  entityRelations: [],
  // K-46: derived, so the content tables' `delete` erasure is in the manifest a host reads.
  erasure: subjectErasureOf(assistantEntities),
  entitlementKey: 'assistant',
  schedules: [],
});

export const assistantMigrations = [
  {
    version: '0001-init',
    sql: `
      CREATE TABLE assistant_threads (
        id            TEXT PRIMARY KEY,
        subject_id    TEXT NOT NULL,
        title         TEXT,
        status        TEXT NOT NULL CHECK (status IN ('open','closed')),
        created_at    TEXT NOT NULL,
        last_event_at TEXT NOT NULL,
        closed_at     TEXT
      );
      CREATE INDEX assistant_threads_by_subject
        ON assistant_threads (subject_id, last_event_at);
      CREATE TABLE assistant_events (
        thread_id  TEXT NOT NULL,
        seq        INTEGER NOT NULL,
        type       TEXT NOT NULL,
        body       TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (thread_id, seq)
      );
      CREATE INDEX assistant_events_by_subject ON assistant_events (subject_id);
      CREATE TABLE assistant_runs (
        thread_id  TEXT PRIMARY KEY,
        run_id     TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        beat_at    TEXT NOT NULL
      );
      CREATE INDEX assistant_runs_by_subject ON assistant_runs (subject_id);
      CREATE TABLE assistant_tool_calls (
        thread_id   TEXT NOT NULL,
        call_id     TEXT NOT NULL,
        tool        TEXT NOT NULL,
        state       TEXT NOT NULL CHECK (state IN
          ('running','awaiting-approval','approved','denied','executing','done','failed')),
        digest      TEXT,
        step        TEXT,
        operation   TEXT,
        version     TEXT,
        expires_at  TEXT,
        nonce       TEXT,
        request_seq INTEGER,
        decided_by  TEXT,
        decided_at  TEXT,
        subject_id  TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        PRIMARY KEY (thread_id, call_id),
        -- An approval's bindings are written together, or not at all.
        CHECK ((digest IS NULL AND step IS NULL AND operation IS NULL AND version IS NULL
                AND expires_at IS NULL AND nonce IS NULL AND request_seq IS NULL)
            OR (digest IS NOT NULL AND step IS NOT NULL AND operation IS NOT NULL AND version IS NOT NULL
                AND expires_at IS NOT NULL AND nonce IS NOT NULL AND request_seq IS NOT NULL))
      );
      CREATE INDEX assistant_tool_calls_by_subject ON assistant_tool_calls (subject_id);
    `,
  },
];

// ---------------------------------------------------------------------------
// Rows, and the way out
// ---------------------------------------------------------------------------

type ThreadRow = z.infer<typeof threadRow>;
type EventRow = z.infer<typeof eventRow>;
type RunRow = z.infer<typeof runRow>;
type ToolCallRow = z.infer<typeof toolCallRow>;

const THREAD_COLUMNS = columnsOf(threadRow);
const EVENT_COLUMNS = columnsOf(eventRow);
const RUN_COLUMNS = columnsOf(runRow);
const CALL_COLUMNS = columnsOf(toolCallRow);

/** A stored row, parsed BEFORE anything is made of it (#771). */
const storedThread = (r: ThreadRow): ThreadRow => returns(threadRow, `thread row ${r.id}`, r);
const storedRun = (r: RunRow): RunRow => returns(runRow, `run row ${r.thread_id}`, r);
const storedCall = (r: ToolCallRow): ToolCallRow =>
  returns(toolCallRow, `tool call row ${r.thread_id}/${r.call_id}`, r);

const toThread = (raw: ThreadRow): Thread => {
  const r = storedThread(raw);
  return returns(threadShape, `thread ${r.id}`, {
    id: r.id,
    subject: r.subject_id,
    title: r.title,
    status: r.status,
    createdAt: r.created_at,
    lastEventAt: r.last_event_at,
    closedAt: r.closed_at,
  });
};

/** A stored event, parsed back through the stream protocol's own schema, with `seq` as its id. */
const toEvent = (raw: EventRow): AssistantStreamEvent => {
  const r = returns(eventRow, `event row ${raw.thread_id}/${raw.seq}`, raw);
  const body = returns(assistantStreamBody, `event ${r.thread_id}/${r.seq}`, JSON.parse(r.body));
  return { ...body, id: r.seq } as AssistantStreamEvent;
};

function getThreadRow(ctx: OperationContext, threadId: string): ThreadRow {
  const row = ctx.sql.query<ThreadRow>(`SELECT ${THREAD_COLUMNS} FROM assistant_threads WHERE id = ?`, [threadId])[0];
  if (!row) throw substratError('not_found', `thread not found: ${threadId}`);
  return storedThread(row);
}

/** The caller's own thread, or `not_found` — never `forbidden`, so existence is not probed. */
function ownThreadRow(ctx: OperationContext, threadId: string): ThreadRow {
  const row = getThreadRow(ctx, threadId);
  if (row.subject_id !== String(ctx.principal)) throw substratError('not_found', `thread not found: ${threadId}`);
  return row;
}

function openThreadRow(row: ThreadRow): ThreadRow {
  if (row.status === 'closed') throw conflict('thread_closed', `thread ${row.id} is closed`);
  return row;
}

function lastEvent(ctx: OperationContext, threadId: string): { seq: number; type: string } | undefined {
  return ctx.sql.query<{ seq: number; type: string }>(
    `SELECT seq, type FROM assistant_events WHERE thread_id = ? ORDER BY seq DESC LIMIT 1`,
    [threadId],
  )[0];
}

function nextSeq(ctx: OperationContext, threadId: string): number {
  return (
    (ctx.sql.query<{ seq: number | null }>(`SELECT MAX(seq) AS seq FROM assistant_events WHERE thread_id = ?`, [
      threadId,
    ])[0]?.seq ?? 0) + 1
  );
}

function callRow(ctx: OperationContext, threadId: string, callId: string): ToolCallRow | undefined {
  const row = ctx.sql.query<ToolCallRow>(
    `SELECT ${CALL_COLUMNS} FROM assistant_tool_calls WHERE thread_id = ? AND call_id = ?`,
    [threadId, callId],
  )[0];
  return row ? storedCall(row) : undefined;
}

function awaitingApproval(ctx: OperationContext, threadId: string): number {
  return (
    ctx.sql.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM assistant_tool_calls WHERE thread_id = ? AND state = 'awaiting-approval'`,
      [threadId],
    )[0]?.n ?? 0
  );
}

/** What an approval request bound, as stored on its call. */
interface Gate {
  digest: string;
  step: string;
  operation: string;
  version: string;
  expiresAt: string;
  nonce: string;
  requestSeq: number;
}

/** The call's approval bindings, or `null` for an ungated call (the table holds all or none). */
function gateOf(call: ToolCallRow): Gate | null {
  if (call.digest === null) return null;
  return {
    digest: call.digest,
    step: call.step!,
    operation: call.operation!,
    version: call.version!,
    expiresAt: call.expires_at!,
    nonce: call.nonce!,
    requestSeq: call.request_seq!,
  };
}

/** The tuple to recompute: the stored bindings, with what the caller brings in their place. */
function bindingOf(
  row: ThreadRow,
  callId: string,
  gate: Gate,
  given: { approver: string; version: string; operation: string; input: unknown },
): ApprovalBinding {
  return {
    version: given.version,
    approver: given.approver,
    thread: row.id,
    step: gate.step,
    call: callId,
    operation: given.operation,
    expiresAt: gate.expiresAt,
    nonce: gate.nonce,
    input: given.input,
  };
}

/** `approvalDigest`, with a binding it cannot digest refused as invalid input rather than thrown raw. */
async function digestOrRefuse(binding: ApprovalBinding): Promise<string> {
  try {
    return await approvalDigest(binding);
  } catch (err) {
    throw substratError('validation_failed', `the approval's bindings cannot be digested: ${(err as Error).message}`);
  }
}

/** True at and after `expiresAt`, by the invocation's clock. */
function expired(ctx: OperationContext, expiresAt: string): boolean {
  return Date.parse(ctx.now()) >= Date.parse(expiresAt);
}

/** The approval-request event a call's bindings came from: where its input is kept. */
function requestEvent(
  ctx: OperationContext,
  threadId: string,
  seq: number,
  callId: string,
): Extract<AssistantStreamBody, { t: 'approval-request' }> {
  const raw = ctx.sql.query<EventRow>(`SELECT ${EVENT_COLUMNS} FROM assistant_events WHERE thread_id = ? AND seq = ?`, [
    threadId,
    seq,
  ])[0];
  const event = raw ? toEvent(raw) : undefined;
  if (!event || event.t !== 'approval-request' || event.callId !== callId) {
    throw substratError('internal', `the approval request for ${callId} is not at seq ${seq} of thread ${threadId}`);
  }
  return event;
}

/** Insert one event and move the thread's activity mark. Returns the event as a client sees it. */
function insertEvent(ctx: OperationContext, row: ThreadRow, body: AssistantStreamBody): AssistantStreamEvent {
  const serialised = JSON.stringify(body);
  // Bytes, not characters: the Durable Object row limit is in bytes.
  // A user's message never gets here over the bound: `sendMessageInput` bounds it in bytes.
  if (utf8Length(serialised) > MAX_EVENT_BYTES) {
    throw substratError(
      'validation_failed',
      `a ${body.t} event is over ${MAX_EVENT_BYTES} bytes — keep a large tool result in the operation that produced it and refer to it by id`,
    );
  }
  const seq = nextSeq(ctx, row.id);
  const now = ctx.now();
  ctx.sql.exec(
    `INSERT INTO assistant_events (thread_id, seq, type, body, subject_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [row.id, seq, body.t, serialised, row.subject_id, now],
  );
  ctx.sql.exec(`UPDATE assistant_threads SET last_event_at = ? WHERE id = ?`, [now, row.id]);
  return { ...body, id: seq } as AssistantStreamEvent;
}

const threadRef = (threadId: string) => ({ entityType: 'assistant-thread', entityId: threadId });

// ---------------------------------------------------------------------------
// In-scope functions (K-16). The registered operations below are their default bindings.
// ---------------------------------------------------------------------------

/**
 * Open a thread for the caller. The caller's principal is the subject: a thread is created
 * for yourself, never on someone else's behalf.
 */
export function createThread(ctx: OperationContext, rawInput?: CreateThreadInput): Thread {
  const input = createThreadInput.parse(rawInput ?? {});
  const id = ulid();
  const now = ctx.now();
  ctx.sql.exec(
    `INSERT INTO assistant_threads (id, subject_id, title, status, created_at, last_event_at, closed_at)
     VALUES (?, ?, ?, 'open', ?, ?, NULL)`,
    [id, String(ctx.principal), input.title ?? null, now, now],
  );
  emitAssistantEvent(ctx, String(ctx.principal), {
    type: 'assistant.thread-created',
    entity: threadRef(id),
    payload: { threadId: id },
  });
  return toThread(getThreadRow(ctx, id));
}

/** One thread. The CALLER decides who may see it; see `assertThreadVisible`. */
export function getThread(ctx: OperationContext, rawInput: ThreadIdInput): Thread {
  return toThread(getThreadRow(ctx, threadIdInput.parse(rawInput).threadId));
}

/**
 * The thread, if the caller may see it: the owner, or someone holding `assistant:audit`.
 * `not_found` otherwise, so a thread's existence is not probed.
 */
export async function assertThreadVisible(ctx: OperationContext, threadId: string): Promise<ThreadRow> {
  const row = getThreadRow(ctx, threadId);
  if (row.subject_id === String(ctx.principal)) return row;
  if ((await ctx.check(ASSISTANT_PERM.audit)).allowed) return row;
  throw substratError('not_found', `thread not found: ${threadId}`);
}

/** Threads for one principal, most recently active first. Unpaged: a vertical folding them. */
export function listThreads(ctx: OperationContext, rawInput?: ListThreadsInput & { subject: string }): Thread[] {
  const input = listThreadsInput.parse(rawInput ?? {});
  const subject = input.subject ?? String(ctx.principal);
  return ctx.sql
    .query<ThreadRow>(
      `SELECT ${THREAD_COLUMNS} FROM assistant_threads
       WHERE subject_id = ? ${input.status ? 'AND status = ?' : ''}
       ORDER BY last_event_at DESC, id DESC`,
      input.status ? [subject, input.status] : [subject],
    )
    .map(toThread);
}

/** The record after a cursor. The CALLER decides who may read it. */
export function readEvents(ctx: OperationContext, rawInput: ReadEventsInput): EventsPage {
  const input = readEventsInput.parse(rawInput);
  getThreadRow(ctx, input.threadId);
  const events = ctx.sql
    .query<EventRow>(
      `SELECT ${EVENT_COLUMNS} FROM assistant_events WHERE thread_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
      [input.threadId, input.after, input.limit],
    )
    .map(toEvent);
  return { events, lastSeq: events.length ? events[events.length - 1]!.id : input.after };
}

/**
 * The user says something, which begins a turn. As the owner, under `assistant:use`.
 *
 * Refused while a turn is running (the host is mid-answer) and while an approval is waiting
 * (the user must answer it, or deny it, first), so the record never holds two turns at once.
 */
export function sendMessage(ctx: OperationContext, rawInput: SendMessageInput): SentMessage {
  const input = sendMessageInput.parse(rawInput);
  const row = openThreadRow(ownThreadRow(ctx, input.threadId));
  if (awaitingApproval(ctx, row.id) > 0) {
    throw conflict('approval_pending', 'an approval is waiting; approve or deny it before saying anything else');
  }
  const last = lastEvent(ctx, row.id);
  if (last && !isRestingEvent({ t: last.type })) {
    throw conflict('turn_in_progress', 'the assistant is still answering the last message');
  }
  const first = insertEvent(ctx, row, { t: 'user-message', text: input.text });
  const second = insertEvent(ctx, row, { t: 'turn-start', v: ASSISTANT_STREAM_VERSION });
  emitAssistantEvent(ctx, row.subject_id, {
    type: 'assistant.turn-started',
    entity: threadRef(row.id),
    payload: { threadId: row.id },
  });
  return { firstSeq: first.id, lastSeq: second.id };
}

/**
 * The user approves or denies a gated tool call. As the owner, under `assistant:use`.
 *
 * An APPROVAL must carry the stored digest (the one the request showed), and that digest must
 * equal the one RECOMPUTED from the stored bindings with the principal who is answering as
 * the approver and `input.version` (the deployed version the host serves the answer under)
 * as the version: an approval of anything else — another input, call, thread or operation,
 * another approver, another deploy — is `digest_mismatch`, never a quiet approval of what is
 * stored. One that arrives at or after the request's expiry is `approval_expired`.
 *
 * A DENIAL needs only the digest the user was shown, with no version or expiry: saying no
 * runs nothing, and it is how the owner clears a request that lapsed or that a deploy made
 * stale, which would otherwise refuse every message (`approval_pending`) for ever. A denial
 * does not end the turn: `approval-resolved` resumes it, like an approval, and the turn stays
 * open (`turn_in_progress` for the owner) until the host writes `turn-finish` or
 * `turn-error`. The owner has no way to end a turn without a run; a host that does not come
 * back leaves closing the thread as the owner's only way out, so a host must run after every
 * answer, a denial included.
 *
 * Single use is the write itself: `UPDATE … WHERE state = 'awaiting-approval' AND digest = ?`,
 * refused unless it changed exactly one row, whatever was read before it.
 *
 * Not fenced by the lease: a run that asked for approval has come to rest, and the user
 * acts between runs. The host starts the next run after this returns.
 */
export async function resolveApproval(ctx: OperationContext, rawInput: ResolveApprovalInput): Promise<{ seq: number }> {
  const input = resolveApprovalInput.parse(rawInput);
  const row = openThreadRow(ownThreadRow(ctx, input.threadId));
  const call = callRow(ctx, row.id, input.callId);
  if (!call) throw substratError('not_found', `no tool call ${input.callId} on thread ${row.id}`);
  if (call.state === 'approved' || call.state === 'denied' || call.state === 'executing' || call.state === 'done') {
    throw conflict('already_resolved', `tool call ${input.callId} was already resolved`);
  }
  const gate = gateOf(call);
  if (call.state !== 'awaiting-approval' || !gate) {
    throw conflict('call_state', `tool call ${input.callId} is not waiting for approval (it is ${call.state})`);
  }
  if (input.approved) {
    if (expired(ctx, gate.expiresAt)) {
      throw conflict('approval_expired', `the approval request for ${input.callId} expired at ${gate.expiresAt}`);
    }
    const request = requestEvent(ctx, row.id, gate.requestSeq, input.callId);
    const expected = await digestOrRefuse(
      bindingOf(row, call.call_id, gate, { approver: String(ctx.principal), version: input.version, operation: gate.operation, input: request.input }),
    );
    // Both: the answer is the digest the user was shown (the stored one), AND that digest is
    // what the bindings recompute to with this approver and this version. Checking only the
    // second would accept a digest a client recomputed for another version.
    if (input.digest !== gate.digest || expected !== gate.digest) {
      throw conflict('digest_mismatch', 'the approval does not match the request: another input, call, approver or deployed version');
    }
  } else if (input.digest !== gate.digest) {
    throw conflict('digest_mismatch', 'the denial is for a different request than the one waiting');
  }
  const now = ctx.now();
  const { changes } = ctx.sql.exec(
    `UPDATE assistant_tool_calls SET state = ?, decided_by = ?, decided_at = ?, updated_at = ?
     WHERE thread_id = ? AND call_id = ? AND state = 'awaiting-approval' AND digest = ?`,
    [input.approved ? 'approved' : 'denied', String(ctx.principal), now, now, row.id, input.callId, gate.digest],
  );
  if (changes !== 1) throw conflict('already_resolved', `tool call ${input.callId} was already resolved`);
  const event = insertEvent(ctx, row, {
    t: 'approval-resolved',
    callId: input.callId,
    approved: input.approved,
    approver: ctx.principal,
    digest: gate.digest,
  });
  emitAssistantEvent(ctx, row.subject_id, {
    type: 'assistant.approval-resolved',
    entity: threadRef(row.id),
    payload: { threadId: row.id, callId: input.callId, tool: call.tool, approved: input.approved },
  });
  return { seq: event.id };
}

/** Close a thread. As the owner. Nothing is appended to a closed thread. */
export function closeThread(ctx: OperationContext, rawInput: ThreadIdInput): Thread {
  const input = threadIdInput.parse(rawInput);
  const row = ownThreadRow(ctx, input.threadId);
  if (row.status === 'closed') return toThread(row);
  ctx.sql.exec(`UPDATE assistant_threads SET status = 'closed', closed_at = ? WHERE id = ?`, [ctx.now(), row.id]);
  ctx.sql.exec(`DELETE FROM assistant_runs WHERE thread_id = ?`, [row.id]);
  emitAssistantEvent(ctx, row.subject_id, {
    type: 'assistant.thread-closed',
    entity: threadRef(row.id),
    payload: { threadId: row.id },
  });
  return toThread(getThreadRow(ctx, row.id));
}

const DEFAULT_STALE_MS = 15_000;

/**
 * Take the single-writer lease on a thread. A holder that has beaten within `staleMs` keeps
 * it (`run_in_progress`); one that has not can be replaced, and `tookOver` says so. The same
 * run asking again simply refreshes its beat.
 */
export function acquireRun(ctx: OperationContext, rawInput: AcquireRunInput): { tookOver: boolean } {
  const input = acquireRunInput.parse(rawInput);
  const row = openThreadRow(getThreadRow(ctx, input.threadId));
  const now = ctx.now();
  const held = ctx.sql.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM assistant_runs WHERE thread_id = ?`, [row.id])[0];
  const current = held ? storedRun(held) : undefined;
  const staleMs = input.staleMs ?? DEFAULT_STALE_MS;
  if (current && current.run_id !== input.runId && Date.parse(now) - Date.parse(current.beat_at) < staleMs) {
    throw conflict('run_in_progress', `thread ${row.id} is being answered by another run`);
  }
  const tookOver = current !== undefined && current.run_id !== input.runId;
  ctx.sql.exec(
    `INSERT INTO assistant_runs (thread_id, run_id, subject_id, beat_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (thread_id) DO UPDATE SET run_id = excluded.run_id, beat_at = excluded.beat_at`,
    [row.id, input.runId, row.subject_id, now],
  );
  return { tookOver };
}

/** Give the lease back. A run that no longer holds it releases nothing. */
export function releaseRun(ctx: OperationContext, rawInput: ReleaseRunInput): { released: boolean } {
  const input = releaseRunInput.parse(rawInput);
  const { changes } = ctx.sql.exec(`DELETE FROM assistant_runs WHERE thread_id = ? AND run_id = ?`, [
    input.threadId,
    input.runId,
  ]);
  return { released: changes > 0 };
}

/** Throws `run_fenced` unless `runId` holds the lease; refreshes its beat when it does. */
function fence(ctx: OperationContext, threadId: string, runId: string): void {
  const held = ctx.sql.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM assistant_runs WHERE thread_id = ?`, [threadId])[0];
  if (!held || storedRun(held).run_id !== runId) {
    throw conflict('run_fenced', `run ${runId} does not hold the lease on thread ${threadId}`);
  }
  ctx.sql.exec(`UPDATE assistant_runs SET beat_at = ? WHERE thread_id = ?`, [ctx.now(), threadId]);
}

/** The events a run may NOT write: they are the user's, written by `sendMessage` and `resolveApproval`. */
const USER_SIDE = new Set<string>(['user-message', 'turn-start', 'approval-resolved']);

/**
 * Append what the assistant said and did, fenced by the lease, and enforce the tool-call
 * state machine on the way in.
 *
 *   tool-input        → `running` (a repeat of a running call is a step restart, and allowed)
 *   approval-request  → `awaiting-approval`, with its bindings stored; the digest must be
 *                       `approvalDigest` of those bindings with the thread's subject as the
 *                       approver, and the expiry still ahead
 *   tool-output       → `done`; for a gated call only from `executing`, i.e. after
 *                       `claimExecution`
 *   tool-error        → `failed`
 *   turn-finish       → `awaiting-approval` only with an approval waiting, `done` only without
 *
 * Every event is refused (`no_turn_open`) unless a turn is open: the last event is not a
 * resting one (`turn-finish`, `turn-error`), and the thread has at least one.
 *
 * `tool-error` may also fail an `approved` call that was never claimed: the host could not
 * run it (the operation refused, the credential ended). That is the host's word, which is why
 * the run key is a system principal's.
 *
 * The whole batch is in the caller's transaction: a refusal anywhere leaves none of it.
 */
export async function appendEvents(ctx: OperationContext, rawInput: AppendEventsInput): Promise<AppendedEvents> {
  const input = appendEventsInput.parse(rawInput);
  const row = openThreadRow(getThreadRow(ctx, input.threadId));
  fence(ctx, row.id, input.runId);
  const stored: AssistantStreamEvent[] = [];
  // A run writes only inside a turn the user opened: after a `turn-start` (or the
  // `approval-resolved` that resumes one) and before the turn rests. Tracked through the
  // batch, so a run cannot rest the turn and go on writing in the same call.
  let last = lastEvent(ctx, row.id)?.type;
  for (const body of input.events) {
    if (USER_SIDE.has(body.t)) {
      throw conflict('not_a_run_event', `a run cannot write a ${body.t} event; that is the user's side of the record`);
    }
    if (last === undefined || isRestingEvent({ t: last })) {
      throw conflict('no_turn_open', `thread ${row.id} has no turn open; the user's next message opens one`);
    }
    await applyToolState(ctx, row, body);
    stored.push(insertEvent(ctx, row, body));
    last = body.t;
  }
  return { events: stored };
}

async function applyToolState(ctx: OperationContext, row: ThreadRow, body: AssistantStreamBody): Promise<void> {
  const now = ctx.now();
  switch (body.t) {
    case 'tool-input': {
      const call = callRow(ctx, row.id, body.callId);
      if (!call) {
        ctx.sql.exec(
          `INSERT INTO assistant_tool_calls
             (thread_id, call_id, tool, state, digest, decided_by, decided_at, subject_id, created_at, updated_at)
           VALUES (?, ?, ?, 'running', NULL, NULL, NULL, ?, ?, ?)`,
          [row.id, body.callId, body.tool, row.subject_id, now, now],
        );
      } else if (call.state !== 'running' || call.tool !== body.tool) {
        throw conflict('call_state', `tool call ${body.callId} already exists and is ${call.state}`);
      }
      return;
    }
    case 'approval-request': {
      const call = callRow(ctx, row.id, body.callId);
      if (!call || call.tool !== body.tool) {
        throw conflict('call_state', `approval requested for ${body.callId}, which has no matching tool-input`);
      }
      const expected = await digestOrRefuse({
        version: body.version,
        approver: row.subject_id,
        thread: row.id,
        step: body.step,
        call: body.callId,
        operation: body.operation,
        expiresAt: body.expiresAt,
        nonce: body.nonce,
        input: body.input,
      });
      if (expected !== body.digest) {
        throw conflict('digest_mismatch', "the digest is not the digest of this request's bindings");
      }
      // A step restart may ask again for a call already waiting on the same request.
      if (call.state === 'awaiting-approval' && call.digest === body.digest) return;
      if (call.state !== 'running') {
        throw conflict('call_state', `tool call ${body.callId} is ${call.state}, not running`);
      }
      if (expired(ctx, body.expiresAt)) {
        throw conflict('approval_expired', `the approval request for ${body.callId} expires at ${body.expiresAt}, which has passed`);
      }
      // The event is inserted right after this returns, at the next seq.
      const requestSeq = nextSeq(ctx, row.id);
      const { changes } = ctx.sql.exec(
        `UPDATE assistant_tool_calls
           SET state = 'awaiting-approval', digest = ?, step = ?, operation = ?, version = ?,
               expires_at = ?, nonce = ?, request_seq = ?, updated_at = ?
         WHERE thread_id = ? AND call_id = ? AND state = 'running'`,
        [body.digest, body.step, body.operation, body.version, body.expiresAt, body.nonce, requestSeq, now, row.id, body.callId],
      );
      if (changes !== 1) throw conflict('call_state', `tool call ${body.callId} is no longer running`);
      emitAssistantEvent(ctx, row.subject_id, {
        type: 'assistant.approval-requested',
        entity: threadRef(row.id),
        payload: { threadId: row.id, callId: body.callId, tool: body.tool },
      });
      return;
    }
    case 'tool-output': {
      const call = callRow(ctx, row.id, body.callId);
      if (!call) throw conflict('call_state', `output for ${body.callId}, which has no tool-input`);
      if (call.digest !== null) {
        // A gated call: only a claimed execution may produce output.
        if (call.state === 'awaiting-approval') throw conflict('approval_required', `tool call ${body.callId} is waiting for approval`);
        if (call.state === 'denied') throw conflict('approval_denied', `tool call ${body.callId} was denied`);
        if (call.state === 'approved') throw conflict('execution_not_claimed', `tool call ${body.callId} was approved but its execution was never claimed`);
        if (call.state !== 'executing') throw conflict('call_state', `tool call ${body.callId} is ${call.state}`);
      } else if (call.state !== 'running') {
        throw conflict('call_state', `tool call ${body.callId} is ${call.state}, not running`);
      }
      ctx.sql.exec(`UPDATE assistant_tool_calls SET state = 'done', updated_at = ? WHERE thread_id = ? AND call_id = ?`, [
        now,
        row.id,
        body.callId,
      ]);
      return;
    }
    case 'tool-error': {
      const call = callRow(ctx, row.id, body.callId);
      if (!call) throw conflict('call_state', `error for ${body.callId}, which has no tool-input`);
      if (call.state !== 'running' && call.state !== 'executing' && call.state !== 'approved') {
        throw conflict('call_state', `tool call ${body.callId} is ${call.state}`);
      }
      ctx.sql.exec(`UPDATE assistant_tool_calls SET state = 'failed', updated_at = ? WHERE thread_id = ? AND call_id = ?`, [
        now,
        row.id,
        body.callId,
      ]);
      return;
    }
    case 'turn-finish': {
      const waiting = awaitingApproval(ctx, row.id);
      if (body.reason === 'awaiting-approval' && waiting === 0) {
        throw conflict('no_approval_pending', 'a turn cannot finish awaiting approval when none is waiting');
      }
      if (body.reason === 'done' && waiting > 0) {
        throw conflict('approval_pending', 'a turn cannot finish while an approval is still waiting');
      }
      emitAssistantEvent(ctx, row.subject_id, {
        type: 'assistant.turn-finished',
        entity: threadRef(row.id),
        payload: { threadId: row.id, reason: body.reason },
      });
      return;
    }
    default:
      return;
  }
}

/**
 * Claim the one execution of an approved tool call, with the operation, the deployed version
 * and the input about to be run.
 *
 * This is the gate in front of a write: the host calls it BEFORE invoking the operation, and
 * runs the operation only if it returns. The digest is recomputed from the stored bindings
 * with the claim's operation, version and input and the principal who approved, and must be
 * the one the user approved (`digest_mismatch` otherwise: the model, or a bug, changed the
 * input, or the host is about to run another operation or under another deploy). The call
 * must be approved (not waiting, not denied), the request's expiry still ahead
 * (`approval_expired`: an approval is spent when it is claimed, and one not spent in time
 * runs nothing), and not already claimed (`already_executed`), so a restarted loop cannot run
 * a write twice — that last is the conditional write itself, `… WHERE state = 'approved'`.
 * Fenced by the lease.
 */
export async function claimExecution(ctx: OperationContext, rawInput: ClaimExecutionInput): Promise<{ claimed: true }> {
  const input = claimExecutionInput.parse(rawInput);
  const row = openThreadRow(getThreadRow(ctx, input.threadId));
  fence(ctx, row.id, input.runId);
  const call = callRow(ctx, row.id, input.callId);
  if (!call) throw substratError('not_found', `no tool call ${input.callId} on thread ${row.id}`);
  const gate = gateOf(call);
  if (!gate) throw conflict('call_state', `tool call ${input.callId} is not gated; there is nothing to claim`);
  if (call.state === 'awaiting-approval') throw conflict('approval_required', `tool call ${input.callId} is waiting for approval`);
  if (call.state === 'denied') throw conflict('approval_denied', `tool call ${input.callId} was denied`);
  if (call.state === 'executing' || call.state === 'done' || call.state === 'failed') {
    throw conflict('already_executed', `tool call ${input.callId} was already claimed (it is ${call.state})`);
  }
  if (call.state !== 'approved' || call.decided_by === null) throw conflict('call_state', `tool call ${input.callId} is ${call.state}`);
  if (expired(ctx, gate.expiresAt)) {
    throw conflict('approval_expired', `the approval for ${input.callId} expired at ${gate.expiresAt} before it was used`);
  }
  const expected = await digestOrRefuse(
    bindingOf(row, call.call_id, gate, { approver: call.decided_by, version: input.version, operation: input.operation, input: input.input }),
  );
  if (expected !== gate.digest) {
    throw conflict('digest_mismatch', 'what is about to run is not what the user approved: another input, operation or deployed version');
  }
  const { changes } = ctx.sql.exec(
    `UPDATE assistant_tool_calls SET state = 'executing', updated_at = ?
     WHERE thread_id = ? AND call_id = ? AND state = 'approved' AND digest = ?`,
    [ctx.now(), row.id, input.callId, gate.digest],
  );
  if (changes !== 1) throw conflict('already_executed', `tool call ${input.callId} was already claimed`);
  return { claimed: true };
}

// ---------------------------------------------------------------------------
// Default operation bindings — each starts with the permission check.
// ---------------------------------------------------------------------------

type Handlers = Parameters<ReturnType<typeof operationsFor<typeof assistantOperations>>>[0];

const createThreadOp: Handlers['assistant/create-thread'] = async (ctx, input) => {
  assertAllowed(await ctx.check(ASSISTANT_PERM.use));
  return createThread(ctx, input);
};

const listThreadsOp: Handlers['assistant/list-threads'] = async (ctx, input) => {
  assertAllowed(await ctx.check(ASSISTANT_PERM.use));
  const asked = input?.subject;
  if (asked !== undefined && asked !== String(ctx.principal)) assertAllowed(await ctx.check(ASSISTANT_PERM.audit));
  const page: ListPage = { ...(input?.limit !== undefined ? { limit: input.limit } : {}), ...(input?.cursor !== undefined ? { cursor: input.cursor } : {}) };
  // Most recent first; the SQL orders by (last_event_at, id) and the cursor is that pair.
  return pageOverFold(
    listThreads(ctx, { ...(input?.status ? { status: input.status } : {}), ...(asked ? { subject: asked } : {}) } as ListThreadsInput & { subject: string }),
    page,
    (t) => `${t.lastEventAt}${CURSOR_FIELD_SEPARATOR}${t.id}`,
    'desc',
  ) as Page<Thread>;
};

const getThreadOp: Handlers['assistant/get-thread'] = async (ctx, input) => {
  assertAllowed(await ctx.check(ASSISTANT_PERM.use));
  await assertThreadVisible(ctx, input.threadId);
  return getThread(ctx, input);
};

const readEventsOp: Handlers['assistant/read-events'] = async (ctx, input) => {
  assertAllowed(await ctx.check(ASSISTANT_PERM.use));
  await assertThreadVisible(ctx, input.threadId);
  return readEvents(ctx, input);
};

const sendMessageOp: Handlers['assistant/send-message'] = async (ctx, input) => {
  assertAllowed(await ctx.check(ASSISTANT_PERM.use));
  return sendMessage(ctx, input);
};

const resolveApprovalOp: Handlers['assistant/resolve-approval'] = async (ctx, input) => {
  assertAllowed(await ctx.check(ASSISTANT_PERM.use));
  return resolveApproval(ctx, input);
};

const closeThreadOp: Handlers['assistant/close-thread'] = async (ctx, input) => {
  assertAllowed(await ctx.check(ASSISTANT_PERM.use));
  return closeThread(ctx, input);
};

const acquireRunOp: Handlers['assistant/acquire-run'] = async (ctx, input) => {
  assertAllowed(await ctx.check(ASSISTANT_PERM.run));
  return acquireRun(ctx, input);
};

const releaseRunOp: Handlers['assistant/release-run'] = async (ctx, input) => {
  assertAllowed(await ctx.check(ASSISTANT_PERM.run));
  return releaseRun(ctx, input);
};

const appendEventsOp: Handlers['assistant/append-events'] = async (ctx, input) => {
  assertAllowed(await ctx.check(ASSISTANT_PERM.run));
  return appendEvents(ctx, input);
};

const claimExecutionOp: Handlers['assistant/claim-execution'] = async (ctx, input) => {
  assertAllowed(await ctx.check(ASSISTANT_PERM.run));
  return claimExecution(ctx, input);
};

export const assistantModule: ModuleRegistration = {
  manifest: assistantManifest,
  migrations: assistantMigrations,
  ...operationsFor(assistantOperations)({
    'assistant/create-thread': createThreadOp,
    'assistant/list-threads': listThreadsOp,
    'assistant/get-thread': getThreadOp,
    'assistant/read-events': readEventsOp,
    'assistant/send-message': sendMessageOp,
    'assistant/resolve-approval': resolveApprovalOp,
    'assistant/close-thread': closeThreadOp,
    'assistant/acquire-run': acquireRunOp,
    'assistant/release-run': releaseRunOp,
    'assistant/append-events': appendEventsOp,
    'assistant/claim-execution': claimExecutionOp,
  }),
};
