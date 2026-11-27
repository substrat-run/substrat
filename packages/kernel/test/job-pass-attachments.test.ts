import { describe, expect, it } from 'vitest';
import type { ScopeStub } from '../src/scope-host.js';
import { runDueJobRuns, type JobHandler, type JobRunRow, type SystemAttachments } from '../src/job-run.js';
import { memoryJobStore } from './job-store-memory.js';

/**
 * #3443: a job pass reaches its scope's files through `pass.attachments()`, opened by the host for
 * the SAME pass token as `pass.scope()` — the token a door's "not now" is tied to (#1834) — once per
 * pass, and refused in words when the host gives the driver no surface.
 */
const T0 = '2026-11-27T12:00:00.000Z';

const row: JobRunRow = {
  id: 'A',
  module_id: '@test/jobs',
  job: 'job',
  instance: 'A',
  payload: '{}',
  subject_id: null,
  status: 'running',
  cursor: null,
  counters: '{}',
  attempts: 0,
  last_error: null,
  started_at: T0,
  updated_at: T0,
  next_attempt_at: null,
  ended_at: null,
  lease_owner: null,
};

const drive = (handler: JobHandler, hooks: Pick<Parameters<typeof runDueJobRuns>[0], 'openScope' | 'openAttachments'>) => {
  const { store, table } = memoryJobStore([{ ...row }]);
  const report = runDueJobRuns({
    store,
    handlerFor: () => ({ handler, retry: { maxAttempts: 3, baseDelayMs: 1_000 } }),
    now: () => T0,
    ...hooks,
  });
  return { report, table };
};

describe('#3443: pass.attachments()', () => {
  it("is opened once per pass, for the run and the pass token scope() is opened with", async () => {
    const scopeTokens: object[] = [];
    const fileOpens: { run: string; pass: object }[] = [];
    const removed: string[] = [];
    const surface: SystemAttachments = {
      open: async () => null,
      remove: async (id) => (removed.push(id), null),
    };
    const { report } = drive(
      async (pass) => {
        await pass.scope();
        await pass.step('one', async () => (await pass.attachments()).remove('att-1'));
        await pass.step('two', async () => (await pass.attachments()).remove('att-2'));
        return { done: true };
      },
      {
        openScope: async (_run, pass) => (scopeTokens.push(pass), {} as ScopeStub),
        openAttachments: async (run, pass) => (fileOpens.push({ run: run.id, pass }), surface),
      },
    );
    expect(await report).toMatchObject({ completed: 1 });
    expect(removed).toEqual(['att-1', 'att-2']);
    expect(fileOpens).toHaveLength(1);
    expect(fileOpens[0]!.run).toBe('A');
    expect(fileOpens[0]!.pass).toBe(scopeTokens[0]);
  });

  it('refuses in words on a host that gives the driver no attachment surface', async () => {
    const { report, table } = drive(
      async (pass) => {
        await pass.step('one', async () => (await pass.attachments()).remove('att-1'));
        return { done: true };
      },
      { openScope: async () => ({}) as ScopeStub },
    );
    expect(await report).toMatchObject({ retrying: 1, completed: 0 });
    expect(table.get('A')!.last_error).toMatch(/no attachment surface/);
  });
});
