import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { manualClock } from '@substrat-run/kernel';
import { engineHarness, type EngineHarness } from '@substrat-run/engine-test-kit';
import { ASSISTANT_PERM as PERM, assistantModule, createThread, getThread, readEvents, sendMessage } from '../src/index.js';
import { columnsOf } from '../src/seam.js';
import { eventRow, runRow, threadRow, toolCallRow } from '../src/entities.js';

/**
 * The seam, under drift (#771/#970) — engine-assistant's copy of workorder's suite.
 *
 * Every test answers one question: when the stored row stops matching the shape this engine
 * PUBLISHES, does the caller get a throw or wrong data? Here the stakes are specific. A stored
 * `body` is handed to a client as an event, so a row that drifted would reach a screen as a
 * half-formed message; and a tool call's `state` is what decides whether a gated write may
 * run, so a row read loosely could let one through a state the engine thinks impossible.
 *
 * The drift is simulated the only honest way available: by moving the table under a running
 * engine, which is what a vertical compiled against 0.3 and running against 0.4 is looking at.
 */

const ALL = [PERM.use, PERM.audit, PERM.run];
const CLOCK_AT = '2030-02-01T00:00:00.000Z';

describe('engine-assistant — the seam is parsed, not asserted', () => {
  let h: EngineHarness;
  let threadId: string;

  beforeEach(async () => {
    h = await engineHarness({ modules: [assistantModule], clock: manualClock(CLOCK_AT).read });
    threadId = await h.run((ctx) => {
      const t = createThread(ctx, { title: 'Squat' });
      sendMessage(ctx, { threadId: t.id, text: 'log my set' });
      return t.id;
    }, ALL);
  });
  afterEach(async () => {
    await h.close();
  });

  /** Move the table under the engine, the way a version bump would. */
  const drift = (sql: string) => h.run((ctx) => void ctx.sql.exec(sql), ALL);

  it('names the columns a row schema describes, in its order', () => {
    expect(columnsOf(threadRow)).toBe('id, subject_id, title, status, created_at, last_event_at, closed_at');
    expect(columnsOf(eventRow)).toBe('thread_id, seq, type, body, subject_id, created_at');
    expect(columnsOf(runRow)).toBe('thread_id, run_id, subject_id, beat_at');
    expect(columnsOf(toolCallRow)).toBe(
      'thread_id, call_id, tool, state, digest, step, operation, version, expires_at, nonce, request_seq, decided_by, decided_at, subject_id, created_at, updated_at',
    );
  });

  it('a column that vanished fails AT THE READ, naming itself', async () => {
    await drift('ALTER TABLE assistant_threads DROP COLUMN title');
    // `SELECT *` would have returned a thread quietly missing its title.
    await expect(h.run((ctx) => getThread(ctx, { threadId }), ALL)).rejects.toThrow(/no such column: title/);
  });

  it('a stored event that is no longer an event is a throw, not a half-formed message', async () => {
    await drift(`UPDATE assistant_events SET body = '{"t":"mystery"}' WHERE seq = 1`);
    await expect(h.run((ctx) => readEvents(ctx, { threadId }), ALL)).rejects.toThrow(/engine-assistant/);
  });

  it('a stored event missing a field its type requires is a throw', async () => {
    // A `user-message` with no `text`.
    await drift(`UPDATE assistant_events SET body = '{"t":"user-message"}' WHERE seq = 1`);
    await expect(h.run((ctx) => readEvents(ctx, { threadId }), ALL)).rejects.toThrow(/engine-assistant/);
  });

  it('a cursor that is not a number cannot be returned to a client as one', async () => {
    await drift(`UPDATE assistant_events SET seq = 'two' WHERE seq = 2`);
    await expect(h.run((ctx) => readEvents(ctx, { threadId }), ALL)).rejects.toThrow(/engine-assistant/);
  });

  it('a thread whose status is no longer a status is a throw', async () => {
    // The CHECK constraint refuses the write on a fresh table; a table from another version
    // may not have it. Rebuild the table without the constraint to stand in for that.
    await drift(`
      CREATE TABLE assistant_threads_v2 AS SELECT * FROM assistant_threads;
      DROP TABLE assistant_threads;
      ALTER TABLE assistant_threads_v2 RENAME TO assistant_threads;
      UPDATE assistant_threads SET status = 'archived';
    `);
    await expect(h.run((ctx) => getThread(ctx, { threadId }), ALL)).rejects.toThrow(/engine-assistant/);
  });
});
