/**
 * Contract suite for async work's invocation lines (#1901): the one line the scope host
 * writes per consumer delivery, executor attempt and schedule run.
 *
 * Every case drives a real scope and reads the lines the host wrote, on both adapters — the
 * Durable Object's consumers run inside workerd and its executors and schedules on the
 * coordinator, the SQLite host does all of it in process, and any of the three could stamp
 * the wrong id, call a failure a success, or let the error's text through.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { moduleId, platformActorId, principalId, scopeId, tenantId, type ScopeId } from '@substrat-run/contracts';
import {
  ASYNC_LINES_PER_PASS,
  ulid,
  type InvocationLogLine,
  type ModuleLogLine,
  type ScopeHost,
} from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { ASYNC_LOG_SECRET_ENTITY, ASYNC_LOG_SECRET_TEXT, asyncLogMod } from './modules.js';

const ASYNC_MODULE = moduleId.parse('@test/asynclog');
const EFFECTOR = 'asynclog-effector';

export type AsyncLogFixture = ScopeHostFixture & {
  /** Every invocation line written so far, in order. */
  lines: () => InvocationLogLine[];
  /** Every `ctx.log` line written so far, in order. */
  logs: () => ModuleLogLine[];
};

export function asyncLogContractSuite(adapterName: string, makeFixture: () => Promise<AsyncLogFixture>): void {
  describe(`async invocation lines (#1901): ${adapterName}`, () => {
    let fixture: AsyncLogFixture;
    let host: ScopeHost;
    const t = tenantId.parse(ulid());
    const staff = platformActorId.parse(ulid());
    const alice = principalId.parse(ulid());
    let s: ScopeId;
    /** The tags the executor ran for — the effect, observed. */
    const effected: string[] = [];

    const scope = async (extra: Record<string, unknown> = {}): Promise<ScopeId> => {
      const id = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t, scopeId: id, vertical: 'asynclog-vertical', ...extra });
      await host.admin.activateScope(staff, t, id);
      return id;
    };
    const act = async (on: ScopeId, tags: string[], fail = false): Promise<string> => {
      const invocationId = ulid();
      const stub = await host.getScope(alice, t, on);
      await stub.invoke('asynclog/act', { tags, fail }, { invocationId });
      return invocationId;
    };
    /** The async lines about one event, by consumer. */
    const linesAbout = (eventTag: string, operation: string) => {
      const ids = new Set(
        fixture
          .logs()
          .filter((l) => l.template === 'consumed {tag}' && l.fields['tag'] === eventTag)
          .map((l) => l.invocationId),
      );
      return fixture.lines().filter((l) => l.kind === 'consumer' && l.operation === operation && ids.has(l.invocationId));
    };
    const byEvent = (eventId: string | null | undefined) => fixture.lines().filter((l) => l.eventId === eventId);

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(asyncLogMod);
      // Retries at once, and dead-letters on the second attempt: the shortest real retry.
      host.registerExecutor(
        EFFECTOR,
        'asynclog.acted',
        async (_admin, event) => {
          const { tag } = event.payload as { tag: string };
          if (tag.startsWith('flaky')) throw new Error(`effector refused ${tag}: ${ASYNC_LOG_SECRET_TEXT}`);
          effected.push(tag);
        },
        { maxAttempts: 2, baseDelayMs: 0 },
      );
      await host.admin.createTenant(staff, { id: t, slug: `asynclog-${t.slice(-8).toLowerCase()}`, name: 'Async log' });
      await host.admin.grantEntitlement(staff, t, 'asynclog');
      s = await scope();
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    it('a delivered consumer writes one info line, under the call it ran in, beside its ctx.log line', async () => {
      const tag = `ok-${ulid()}`;
      const invocationId = await act(s, [tag]);
      const [line, ...more] = fixture
        .lines()
        .filter((l) => l.kind === 'consumer' && l.operation === '@test/asynclog' && l.invocationId === invocationId);
      expect(more).toEqual([]);
      expect(line).toMatchObject({
        substrat: 'invocation',
        kind: 'consumer',
        tenantId: t,
        scopeId: s,
        method: null,
        path: null,
        status: null,
        threw: false,
        level: 'info',
        outcome: 'delivered',
        operation: '@test/asynclog',
        eventType: 'asynclog.acted',
        attempt: 1,
        problemCode: null,
        principalKind: 'system',
      });
      expect(line!.eventId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      // The handler's ctx.log line joins it: same id, so the call's drill-down shows both.
      expect(fixture.logs().find((l) => l.fields['tag'] === tag)).toMatchObject({ invocationId, operation: null });
    });

    it('outside any call, a delivery mints its own id, and its ctx.log line still joins it', async () => {
      const tag = `nocall-${ulid()}`;
      const stub = await host.getScope(alice, t, s);
      // No invocation id: the tail that delivers the event runs in no call.
      await stub.invoke('asynclog/act', { tags: [tag], fail: false });
      const log = fixture.logs().find((l) => l.fields['tag'] === tag);
      expect(log?.invocationId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(linesAbout(tag, '@test/asynclog')).toEqual([
        expect.objectContaining({ kind: 'consumer', outcome: 'delivered', invocationId: log!.invocationId }),
      ]);
    });

    it('a consumer that throws is an error line, dead-lettered, with the code and none of the text', async () => {
      const tag = `refuse-${ulid()}`;
      const invocationId = await act(s, [tag], true);
      const [line] = fixture
        .lines()
        .filter((l) => l.kind === 'consumer' && l.operation === '@test/asynclog' && l.invocationId === invocationId);
      expect(line).toMatchObject({
        level: 'error',
        threw: true,
        outcome: 'dead-lettered',
        problemCode: 'precondition_failed',
        attempt: 1,
      });
      // Ids, names and codes only: neither the error's text nor the payload's tag.
      const text = JSON.stringify(line);
      expect(text).not.toContain(ASYNC_LOG_SECRET_TEXT);
      expect(text).not.toContain(tag);
      expect(linesAbout(tag, '@test/asynclog')).toEqual([line]);
    });

    it('an executor that throws is retrying on attempt 1 and dead-lettered on attempt 2, each its own line', async () => {
      const tag = `flaky-${ulid()}`;
      const invocationId = await act(s, [tag]);
      const first = fixture
        .lines()
        .find((l) => l.operation === `executor:${EFFECTOR}` && l.invocationId === invocationId);
      expect(first).toMatchObject({
        kind: 'consumer',
        level: 'error',
        threw: true,
        outcome: 'retrying',
        attempt: 1,
        eventType: 'asynclog.acted',
      });
      expect(JSON.stringify(first)).not.toContain(ASYNC_LOG_SECRET_TEXT);

      // The retry runs in a sweep, which is no call: its line mints its own id.
      const report = await host.drainDue(t, s);
      expect(report.deadLettered).toBeGreaterThanOrEqual(1);
      const attempts = byEvent(first!.eventId).filter((l) => l.operation === `executor:${EFFECTOR}`);
      expect(attempts.map((l) => [l.attempt, l.outcome, l.level])).toEqual([
        [1, 'retrying', 'error'],
        [2, 'dead-lettered', 'error'],
      ]);
      expect(attempts[1]!.invocationId).not.toBe(invocationId);
    });

    it('a delivered executor is an info line, and a drain with nothing due writes none', async () => {
      const tag = `effect-${ulid()}`;
      const invocationId = await act(s, [tag]);
      expect(effected).toContain(tag);
      const line = fixture.lines().find((l) => l.operation === `executor:${EFFECTOR}` && l.invocationId === invocationId);
      expect(line).toMatchObject({ outcome: 'delivered', level: 'info', attempt: 1, threw: false });
      const before = fixture.lines().length;
      await host.drainDue(t, s);
      expect(fixture.lines().slice(before).filter((l) => l.scopeId === s)).toEqual([]);
    });

    it('a copy of a scope logs its held deliveries as inert — a warning, never delivered', async () => {
      const copy = await scope({ kind: 'preview' });
      const tag = `inert-${ulid()}`;
      const invocationId = await act(copy, [tag]);
      expect(effected).not.toContain(tag);
      const line = fixture.lines().find((l) => l.operation === `executor:${EFFECTOR}` && l.invocationId === invocationId);
      expect(line).toMatchObject({ scopeId: copy, outcome: 'inert', level: 'warn', threw: false });
      expect(fixture.lines().filter((l) => l.eventId === line!.eventId && l.operation === `executor:${EFFECTOR}`)).toEqual([
        line,
      ]);
    });

    it('a schedule run writes a schedule line under the run id its ctx.log lines carry, with its lateness', async () => {
      const report = await host.runDueSchedules(ASYNC_MODULE, t, s);
      expect(report.fired).toBe(1);
      expect(report.failed).toBe(1);
      const ok = fixture.lines().find((l) => l.kind === 'schedule' && l.scopeId === s && l.operation === 'asynclog/tick');
      expect(ok).toMatchObject({
        kind: 'schedule',
        tenantId: t,
        outcome: 'ok',
        level: 'info',
        threw: false,
        principalKind: 'system',
        // A first run has no due time to be late against.
        dueAt: null,
        latenessMs: null,
        method: null,
        path: null,
      });
      expect(fixture.logs().find((l) => l.template === 'ticked' && l.scopeId === s)?.invocationId).toBe(ok!.invocationId);
      // What the run emitted is counted by declared type; the entity — an email — is not named,
      // on its line or on the line of the consumer it reached.
      expect(ok).toMatchObject({ eventCount: 1, eventTypes: ['asynclog.acted'], entities: [] });
      const ofRun = fixture.lines().filter((l) => l.invocationId === ok!.invocationId);
      expect(ofRun.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(ofRun)).not.toContain(ASYNC_LOG_SECRET_ENTITY);

      const failed = fixture
        .lines()
        .find((l) => l.kind === 'schedule' && l.scopeId === s && l.operation === 'asynclog/tick-fails');
      expect(failed).toMatchObject({ outcome: 'failed', level: 'error', threw: true, problemCode: 'conflict' });
      expect(JSON.stringify(failed)).not.toContain(ASYNC_LOG_SECRET_TEXT);
      expect(
        fixture.logs().find((l) => l.template === 'ticking, about to refuse' && l.scopeId === s)?.invocationId,
      ).toBe(failed!.invocationId);

      // Not due again: a skipped schedule writes nothing.
      const before = fixture.lines().length;
      await host.runDueSchedules(ASYNC_MODULE, t, s);
      expect(fixture.lines().slice(before).filter((l) => l.kind === 'schedule' && l.scopeId === s)).toEqual([]);
    });

    it(`a pass over its cap writes ${ASYNC_LINES_PER_PASS} lines and one that counts the rest by outcome`, async () => {
      const capped = await scope();
      const tags = Array.from({ length: ASYNC_LINES_PER_PASS + 5 }, (_, i) => `burst-${i}-${ulid()}`);
      const invocationId = await act(capped, tags, true);
      const ofModule = fixture
        .lines()
        .filter((l) => l.scopeId === capped && l.operation === '@test/asynclog' && l.invocationId === invocationId);
      expect(ofModule).toHaveLength(ASYNC_LINES_PER_PASS);
      const suppressed = fixture
        .lines()
        .filter((l) => l.scopeId === capped && l.outcome === 'suppressed' && l.invocationId === invocationId);
      // One per pass that went over, each naming what it withheld by outcome — so the module
      // consumers' dead-letter storm is named as one, at the worst level it withheld, and the
      // executor's deliveries beside it stay info.
      expect(suppressed.map((l) => [l.operation, l.suppressed, l.suppressedBy, l.level]).sort()).toEqual([
        [null, 5, { 'consumer:dead-lettered': 5 }, 'error'],
        [null, 5, { 'consumer:delivered': 5 }, 'info'],
      ]);
    });
  });
}
