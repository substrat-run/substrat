/**
 * The scheduling contract of `useAutoRefresh`, exercised on `startAutoRefresh` with a
 * fake window/document/clock — no DOM, no React, so the rules it states are the rules
 * it keeps: nothing while hidden, one refresh per tab return, a slow poll, rejections
 * swallowed, everything gone on stop.
 */
import { describe, expect, it } from 'vitest';
import { MIN_GAP_MS, startAutoRefresh, type AutoRefreshEnv } from '../src/hooks/auto-refresh';

function fakeEnv() {
  const listeners = new Map<string, Set<() => void>>();
  const on = (type: string, fn: () => void) => {
    let set = listeners.get(type);
    if (!set) listeners.set(type, (set = new Set()));
    set.add(fn);
  };
  const off = (type: string, fn: () => void) => listeners.get(type)?.delete(fn);
  const timers: { fn: () => void; ms: number }[] = [];
  let now = 1_000_000;
  let visibility: 'visible' | 'hidden' = 'visible';
  const env: AutoRefreshEnv = {
    window: { addEventListener: on, removeEventListener: off },
    document: {
      get visibilityState() {
        return visibility;
      },
      addEventListener: on,
      removeEventListener: off,
    },
    now: () => now,
    setInterval: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
    clearInterval: (handle) => {
      const i = timers.indexOf(handle as (typeof timers)[number]);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  return {
    env,
    timers,
    fire: (type: string) => listeners.get(type)?.forEach((fn) => fn()),
    tick: () => timers.forEach((t) => t.fn()),
    advance: (ms: number) => (now += ms),
    hide: () => (visibility = 'hidden'),
    show: () => (visibility = 'visible'),
    listenerCount: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('startAutoRefresh', () => {
  it('does not refresh on start — the caller’s initial load already ran', () => {
    const f = fakeEnv();
    let calls = 0;
    startAutoRefresh(() => calls++, { intervalMs: 30_000, env: f.env });
    expect(calls).toBe(0);
  });

  it('refreshes once when the tab comes back, though focus and visibilitychange both fire', () => {
    const f = fakeEnv();
    let calls = 0;
    startAutoRefresh(() => calls++, { intervalMs: 30_000, env: f.env });
    f.advance(MIN_GAP_MS);
    f.fire('visibilitychange');
    f.fire('focus');
    expect(calls).toBe(1);
  });

  it('never fires while the tab is hidden, and catches up on return', () => {
    const f = fakeEnv();
    let calls = 0;
    startAutoRefresh(() => calls++, { intervalMs: 30_000, env: f.env });
    f.hide();
    f.advance(60_000);
    f.fire('focus');
    f.tick();
    expect(calls).toBe(0);
    f.show();
    f.fire('visibilitychange');
    expect(calls).toBe(1);
  });

  it('polls at the interval while visible', () => {
    const f = fakeEnv();
    let calls = 0;
    startAutoRefresh(() => calls++, { intervalMs: 12_345, env: f.env });
    expect(f.timers.map((t) => t.ms)).toEqual([12_345]);
    f.advance(12_345);
    f.tick();
    f.advance(12_345);
    f.tick();
    expect(calls).toBe(2);
  });

  it('collapses refreshes closer together than the gap into one', () => {
    const f = fakeEnv();
    let calls = 0;
    startAutoRefresh(() => calls++, { intervalMs: 30_000, env: f.env });
    f.advance(MIN_GAP_MS);
    f.fire('focus');
    f.advance(MIN_GAP_MS - 1);
    f.fire('focus');
    f.tick();
    expect(calls).toBe(1);
    f.advance(1);
    f.fire('focus');
    expect(calls).toBe(2);
  });

  it('swallows a rejection and a synchronous throw alike — the caller’s load() owns its errors', async () => {
    const f = fakeEnv();
    let calls = 0;
    startAutoRefresh(
      () => {
        calls++;
        if (calls === 1) throw new Error('sync');
        return Promise.reject(new Error('async'));
      },
      { intervalMs: 30_000, env: f.env },
    );
    f.advance(MIN_GAP_MS);
    expect(() => f.fire('focus')).not.toThrow();
    f.advance(MIN_GAP_MS);
    expect(() => f.fire('focus')).not.toThrow();
    await settle();
    expect(calls).toBe(2);
  });

  it('stop tears the listeners and the poll down', () => {
    const f = fakeEnv();
    let calls = 0;
    const controller = startAutoRefresh(() => calls++, { intervalMs: 30_000, env: f.env });
    expect(f.listenerCount()).toBe(2);
    controller.stop();
    expect(f.listenerCount()).toBe(0);
    expect(f.timers).toEqual([]);
    f.advance(60_000);
    f.fire('focus');
    expect(calls).toBe(0);
  });
});
