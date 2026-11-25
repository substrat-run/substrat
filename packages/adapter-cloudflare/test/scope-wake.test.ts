/**
 * K-69 (no scheduled walk over tenants): a scope with work for the platform wakes itself, and an
 * idle scope arms nothing. The decision (`scope-wake.ts`) first, on its own clock; then the real
 * object (`WakeScopeDO`, test/worker.ts), whose kicks this suite answers by standing in for `fetch`.
 */
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { permissionKey, principalId, scopeId, tenantId, type ScopeId } from '@substrat-run/contracts';
import { PLATFORM_SECRET_HEADER } from '@substrat-run/contracts/wire-headers';
import { ulid } from '@substrat-run/kernel';
import {
  SCOPE_WAKE_BACKOFF_MS,
  SCOPE_WAKE_EVENTS_DELAY_MS,
  SCOPE_WAKE_INTENTS_DELAY_MS,
  SCOPE_WAKE_KEY,
  SCOPE_WAKE_PASS_HOLD_MS,
  runWake,
  wakeAfterCommit,
  wakeDueAt,
  type ScopeWakeState,
  type WakeAnswer,
  type WakeKick,
} from '../src/scope-wake.js';
import { CloudflareScopeHost } from './test-host.js';
import { WAKE_CONTROL_PLANE_URL } from './worker.js';

const ids = { tenantId: tenantId.parse(ulid()), scopeId: scopeId.parse(ulid()) };
const NOW = Date.parse('2026-11-25T10:00:00Z');
const nothing = { newestIntent: null, undrainedEvents: false };

describe('the wake decision (scope-wake.ts)', () => {
  const kicks: WakeKick[] = [];
  const answering = (answer: WakeAnswer | null) => async (body: WakeKick) => {
    kicks.push(body);
    return answer;
  };
  beforeEach(() => {
    kicks.length = 0;
  });

  it('arms nothing for a commit that left no work', () => {
    expect(wakeAfterCommit(null, ids, nothing, NOW)).toBeNull();
    expect(wakeDueAt(null)).toBeNull();
  });

  it('asks for an intent drain within seconds, and only once per new intent', () => {
    const armed = wakeAfterCommit(null, ids, { newestIntent: 'A', undrainedEvents: false }, NOW)!;
    expect(wakeDueAt(armed)).toBe(NOW + SCOPE_WAKE_INTENTS_DELAY_MS);
    // Already armed: a second commit changes nothing.
    expect(wakeAfterCommit(armed, ids, { newestIntent: 'A', undrainedEvents: false }, NOW + 1)).toBeNull();
    // Looked at (`intentsMark`): a commit with no newer intent asks nothing, though `A` is still pending.
    expect(wakeAfterCommit({ ...armed, due: {}, intentsMark: 'A' }, ids, { newestIntent: 'A', undrainedEvents: false }, NOW)).toBeNull();
    expect(wakeAfterCommit({ ...armed, due: {}, intentsMark: 'A' }, ids, { newestIntent: 'B', undrainedEvents: false }, NOW)).not.toBeNull();
  });

  it('coalesces the lake drain over its window and keeps the earliest due', () => {
    const armed = wakeAfterCommit(null, ids, { newestIntent: null, undrainedEvents: true }, NOW)!;
    expect(wakeDueAt(armed)).toBe(NOW + SCOPE_WAKE_EVENTS_DELAY_MS);
    expect(wakeAfterCommit(armed, ids, { newestIntent: null, undrainedEvents: true }, NOW + 60_000)).toBeNull();
    const both = wakeAfterCommit(armed, ids, { newestIntent: 'A', undrainedEvents: true }, NOW + 60_000)!;
    expect(wakeDueAt(both)).toBe(NOW + 60_000 + SCOPE_WAKE_INTENTS_DELAY_MS);
  });

  it('while the control plane owns the phase, looks again on the back-off until the work is gone', async () => {
    let state: ScopeWakeState | null = wakeAfterCommit(null, ids, { newestIntent: 'A', undrainedEvents: false }, NOW);
    const at: number[] = [];
    let now = NOW;
    for (let i = 0; i < SCOPE_WAKE_BACKOFF_MS.length + 1; i++) {
      now = wakeDueAt(state)!;
      state = await runWake(state!, now, () => ({ newestIntent: 'A', pendingIntents: true, undrainedEvents: false }), answering({ platformRequests: 'scope' }));
      at.push(wakeDueAt(state)! - now);
    }
    expect(at).toEqual([...SCOPE_WAKE_BACKOFF_MS, SCOPE_WAKE_BACKOFF_MS.at(-1)]);
    expect(kicks.every((k) => k.platformRequests && !k.events && k.source === 'scope')).toBe(true);
    // The drain took it: the next look asks nothing, and nothing stays armed.
    state = await runWake(state!, wakeDueAt(state)!, () => ({ newestIntent: 'A', pendingIntents: false, undrainedEvents: false }), answering({}));
    expect(kicks).toHaveLength(SCOPE_WAKE_BACKOFF_MS.length + 1);
    expect(wakeDueAt(state)).toBeNull();
    expect(state?.intentsMark).toBe('A');
  });

  it('leaves a phase the pass still owns to the pass, and holds the lake off for an hour', async () => {
    const armed = wakeAfterCommit(null, ids, { newestIntent: 'A', undrainedEvents: true }, NOW)!;
    const then = NOW + SCOPE_WAKE_EVENTS_DELAY_MS;
    // A control plane that predates the answer says nothing, which reads as the pass owning both.
    const state = await runWake(armed, then, () => ({ newestIntent: 'A', pendingIntents: true, undrainedEvents: true }), answering({}));
    expect(kicks).toEqual([{ ...ids, platformRequests: true, events: true, source: 'scope' }]);
    expect(wakeDueAt(state)).toBeNull();
    expect(state!.eventsHeldUntil).toBe(then + SCOPE_WAKE_PASS_HOLD_MS);
    expect(wakeAfterCommit(state, ids, { newestIntent: 'A', undrainedEvents: true }, then + 1)).toBeNull();
    expect(wakeAfterCommit(state, ids, { newestIntent: 'A', undrainedEvents: true }, then + SCOPE_WAKE_PASS_HOLD_MS + 1)).not.toBeNull();
  });

  it('asks again on the back-off when a kick does not land', async () => {
    const armed = wakeAfterCommit(null, ids, { newestIntent: null, undrainedEvents: true }, NOW)!;
    const then = NOW + SCOPE_WAKE_EVENTS_DELAY_MS;
    const state = await runWake(armed, then, () => ({ newestIntent: null, pendingIntents: false, undrainedEvents: true }), async () => {
      throw new Error('connection refused');
    });
    expect(wakeDueAt(state)).toBe(then + SCOPE_WAKE_BACKOFF_MS[0]!);
    expect(state!.eventsHeldUntil).toBeUndefined();
  });
});

describe('a real scope object wakes itself (WakeScopeDO)', () => {
  const t = tenantId.parse(ulid());
  const owner = principalId.parse(ulid());
  const USE = permissionKey.parse('perm:use');
  const host = new CloudflareScopeHost({ scope: env.WAKE_SCOPE });
  const kicks: { secret: string | null; body: WakeKick }[] = [];
  let answer: WakeAnswer = { platformRequests: 'scope', events: 'scope' };
  const realFetch = globalThis.fetch;
  const stubOf = (s: ScopeId) => env.WAKE_SCOPE.get(env.WAKE_SCOPE.idFromName(s));
  const wakeOf = (s: ScopeId) =>
    runInDurableObject(stubOf(s), async (_i, state) => ({
      wake: (await state.storage.get<ScopeWakeState>(SCOPE_WAKE_KEY)) ?? null,
      alarm: await state.storage.getAlarm(),
    }));
  /** Bring the wake's due times to now, as the clock would, and run the alarm it armed. */
  const fireWake = async (s: ScopeId) => {
    await runInDurableObject(stubOf(s), async (_i, state) => {
      const w = (await state.storage.get<ScopeWakeState>(SCOPE_WAKE_KEY))!;
      const due = Object.fromEntries(Object.keys(w.due).map((p) => [p, Date.now() - 1]));
      await state.storage.put(SCOPE_WAKE_KEY, { ...w, due });
    });
    // The alarm the wake armed, run now rather than at its time.
    expect(await runDurableObjectAlarm(stubOf(s))).toBe(true);
  };
  const provision = (s: ScopeId) =>
    host.provisionScopeLocal({
      tenantId: t,
      scopeId: s,
      owner,
      roles: [{ key: 'office-admin', permissions: [USE], source: 'vertical' }],
      ownerRoleKey: 'office-admin',
    });

  beforeAll(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== WAKE_CONTROL_PLANE_URL) return realFetch(input, init);
      const headers = new Headers(init?.headers);
      kicks.push({ secret: headers.get(PLATFORM_SECRET_HEADER), body: JSON.parse(String(init?.body)) as WakeKick });
      return Response.json({ drained: 0, done: 0, failed: 0, pending: 0, drain: 'deferred', wake: answer });
    });
  });
  afterAll(() => {
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    kicks.length = 0;
    answer = { platformRequests: 'scope', events: 'scope' };
  });

  it('an intent arms the alarm within seconds, and the alarm asks for this scope with the platform secret', async () => {
    const s = scopeId.parse(ulid());
    await provision(s);
    const before = Date.now();
    await (await host.getScope(owner, t, s)).invoke('platform/request', { kind: 'test.wake', payload: {} });
    const armed = await wakeOf(s);
    expect(armed.wake!.due.intents).toBeGreaterThanOrEqual(before + SCOPE_WAKE_INTENTS_DELAY_MS);
    expect(armed.alarm).toBeLessThanOrEqual(armed.wake!.due.intents!);

    await fireWake(s);
    expect(kicks).toHaveLength(1);
    expect(kicks[0]).toEqual({ secret: 'wake-test-secret', body: { tenantId: t, scopeId: s, platformRequests: true, events: false, source: 'scope' } });
    // The intent is still pending (nobody drained it): looked at again on the back-off.
    const after = await wakeOf(s);
    expect(after.wake!.retries).toEqual({ intents: 1 });
    expect(after.alarm).not.toBeNull();
  });

  it('an idle scope keeps nothing armed and is never asked about', async () => {
    const s = scopeId.parse(ulid());
    await provision(s);
    const stub = await host.getScope(owner, t, s);
    // Its provisioning events shipped by somebody else, as the pass or another kick would have.
    await runInDurableObject(stubOf(s), (_i, state) => {
      state.storage.sql.exec('UPDATE _substrat_outbox SET drained_at = ? WHERE drained_at IS NULL', new Date().toISOString());
    });
    if ((await wakeOf(s)).wake) await fireWake(s);
    expect(await wakeOf(s)).toEqual({ wake: null, alarm: null });
    expect(kicks).toHaveLength(0);
    // A read commits nothing a platform drain wants: still nothing armed.
    await stub.invoke('platform/read-requests');
    expect(await wakeOf(s)).toEqual({ wake: null, alarm: null });
  });

  it('a control plane whose pass owns both phases gets the one kick and no retries', async () => {
    answer = { platformRequests: 'pass', events: 'pass' };
    const s = scopeId.parse(ulid());
    await provision(s);
    const stub = await host.getScope(owner, t, s);
    await stub.invoke('test/emit-event', { subject: ulid() });
    await stub.invoke('platform/request', { kind: 'test.wake', payload: {} });
    await fireWake(s);
    expect(kicks.map((k) => k.body)).toEqual([{ tenantId: t, scopeId: s, platformRequests: true, events: true, source: 'scope' }]);
    const after = await wakeOf(s);
    expect(after.wake!.due).toEqual({});
    expect(after.wake!.eventsHeldUntil).toBeGreaterThan(Date.now());
  });
});
