import { defineEntities } from '@substrat-run/contracts';
import { z } from 'zod';

/**
 * engine-assistant's entities (docs/rfc/assistant.md §5.2).
 *
 * The record of a chat between a person and an assistant, and nothing about the model that
 * speaks for it. Four tables, three of which are the thread's own rows and one of which is a
 * lease.
 *
 * - **`assistant-thread`** is one conversation, owned by one principal (`subject_id`). It is
 *   the entity the platform points at: every event this engine emits names it.
 * - **`assistant-event`** is one event of the thread, in the stream protocol's own shape
 *   (`assistantStreamBody`), numbered `seq` from 1 per thread. APPEND-ONLY: nothing here is
 *   updated or deleted by the engine. `seq` is the cursor a client resumes after. `body` is
 *   the event serialised, without its `seq`, and is where the person's words live.
 * - **`assistant-run`** is the single-writer lease: which run may append the assistant's
 *   events to a thread right now, and when it last beat. Not an entity of the person's, but
 *   it carries `subject_id` so an erasure leaves no row naming a thread that is gone.
 * - **`assistant-tool-call`** is the state a tool call passes through, which is where the
 *   engine's central invariant lives: a gated write runs only from `approved`, once, with the
 *   input whose digest the user saw.
 *
 * Erasure (K-46). Everything that holds what the person said or what the assistant did for
 * them is theirs whole, so each table names `subject_id` as its subject column and erases by
 * `delete`. The rows have no `id` of their own to survive an erasure with, and nothing about
 * a thread is meaningful once its owner is gone. The events this engine EMITS carry no text,
 * no tool input or output and no digest of one, and every one is `pseudonymous` with the
 * thread's subject as its `subjectId`, so the same erasure redacts their payloads too.
 */
export const assistantEntities = defineEntities({
  'assistant-thread': {
    table: 'assistant_threads',
    fields: z.object({
      id: z.string(),
      subject_id: z.string(),
      title: z.string().nullable(),
      status: z.enum(['open', 'closed']),
      created_at: z.string(),
      last_event_at: z.string(),
      closed_at: z.string().nullable(),
    }),
    erasable: ['title'],
    erasure: { subjects: ['subject_id'], mode: 'delete' },
  },
  'assistant-event': {
    table: 'assistant_events',
    fields: z.object({
      thread_id: z.string(),
      seq: z.number(),
      type: z.string(),
      body: z.string(),
      subject_id: z.string(),
      created_at: z.string(),
    }),
    primaryKey: ['thread_id', 'seq'],
    erasable: ['body'],
    erasure: { subjects: ['subject_id'], mode: 'delete' },
  },
  'assistant-run': {
    table: 'assistant_runs',
    fields: z.object({
      thread_id: z.string(),
      run_id: z.string(),
      subject_id: z.string(),
      beat_at: z.string(),
    }),
    primaryKey: ['thread_id'],
    // Holds no words, but the principal's id says whose thread this lease was on.
    erasable: ['subject_id'],
    erasure: { subjects: ['subject_id'], mode: 'delete' },
  },
  'assistant-tool-call': {
    table: 'assistant_tool_calls',
    fields: z.object({
      thread_id: z.string(),
      call_id: z.string(),
      tool: z.string(),
      state: z.enum(['running', 'awaiting-approval', 'approved', 'denied', 'executing', 'done', 'failed']),
      digest: z.string().nullable(),
      // What the approval request bound (`approvalDigest`), kept so an answer and a claim can
      // recompute the digest rather than trust one. Set together with `digest`, or all null.
      // The input itself is not copied here: `request_seq` points at the request event.
      step: z.string().nullable(),
      operation: z.string().nullable(),
      version: z.string().nullable(),
      expires_at: z.string().nullable(),
      nonce: z.string().nullable(),
      request_seq: z.number().nullable(),
      decided_by: z.string().nullable(),
      decided_at: z.string().nullable(),
      subject_id: z.string(),
      created_at: z.string(),
      updated_at: z.string(),
    }),
    primaryKey: ['thread_id', 'call_id'],
    // The tool name and the digest are not the person's, but who the call was for, and who
    // decided it, are.
    erasable: ['subject_id', 'decided_by'],
    erasure: { subjects: ['subject_id'], mode: 'delete' },
  },
});

/** One thread, as stored. */
export const threadRow = assistantEntities['assistant-thread'].fields;
/** One event of a thread, as stored. */
export const eventRow = assistantEntities['assistant-event'].fields;
/** The lease on a thread, as stored. */
export const runRow = assistantEntities['assistant-run'].fields;
/** One tool call's state, as stored. */
export const toolCallRow = assistantEntities['assistant-tool-call'].fields;
