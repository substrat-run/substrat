import { describe, it, expect } from 'vitest';
import { cachedTelemetry, telemetryKey, type TelemetryCacheOutcome, type TelemetryStore } from '../src/telemetry-cache.js';

/** A Map standing in for the Cache API: same two verbs, same Response in and out. */
const memoryStore = (): TelemetryStore & { entries: Map<string, string> } => {
  const entries = new Map<string, string>();
  return {
    entries,
    match: async (key) => (entries.has(key) ? new Response(entries.get(key)) : undefined),
    put: async (key, res) => void entries.set(key, await res.text()),
  };
};

describe('telemetry cache', () => {
  it('puts the tenant in every key, so one tenant’s series is never another’s', () => {
    const a = telemetryKey('tenant-a', 'metrics', { hours: 24 });
    const b = telemetryKey('tenant-b', 'metrics', { hours: 24 });
    expect(a).not.toBe(b);
    expect(new URL(a).pathname).toBe('/tenant-a/metrics');
    // Unroutable by construction: nothing outside the worker can ask for an entry.
    expect(new URL(a).hostname.endsWith('.invalid')).toBe(true);
  });

  it('keys the question, not its spelling — parameter and list order do not matter', () => {
    expect(telemetryKey('t', 'series', { scopeIds: ['b', 'a'], hours: 24 })).toBe(
      telemetryKey('t', 'series', { hours: 24, scopeIds: ['a', 'b'] }),
    );
    expect(telemetryKey('t', 'metrics', { hours: 24, vertical: undefined })).toBe(telemetryKey('t', 'metrics', { hours: 24 }));
    expect(telemetryKey('t', 'metrics', { hours: 24 })).not.toBe(telemetryKey('t', 'metrics', { hours: 168 }));
  });

  it('reads once, then answers from the store', async () => {
    const store = memoryStore();
    const outcomes: TelemetryCacheOutcome[] = [];
    let reads = 0;
    const load = async () => ({ requests: ++reads });
    const key = telemetryKey('t', 'metrics', { hours: 24 });
    const onOutcome = (o: TelemetryCacheOutcome) => outcomes.push(o);
    expect(await cachedTelemetry(store, key, load, { onOutcome })).toEqual({ requests: 1 });
    expect(await cachedTelemetry(store, key, load, { onOutcome })).toEqual({ requests: 1 });
    expect(reads).toBe(1);
    expect(outcomes).toEqual(['miss', 'hit']);
  });

  it('never remembers an empty answer or a failed read', async () => {
    const store = memoryStore();
    const key = telemetryKey('t', 'series', { hours: 24 });
    expect(await cachedTelemetry(store, key, async () => null)).toBeNull();
    await expect(cachedTelemetry(store, key, async () => Promise.reject(new Error('plane down')))).rejects.toThrow('plane down');
    expect(store.entries.size).toBe(0);
    // …so the backend coming back is seen on the very next read.
    expect(await cachedTelemetry(store, key, async () => [1])).toEqual([1]);
  });

  it('can only ever cost a hit: a broken store falls through to the live read', async () => {
    const broken: TelemetryStore = {
      match: async () => Promise.reject(new Error('cache unavailable')),
      put: async () => Promise.reject(new Error('cache unavailable')),
    };
    expect(await cachedTelemetry(broken, 'k', async () => 'live')).toBe('live');
    const garbled: TelemetryStore = { match: async () => new Response('not json'), put: async () => {} };
    expect(await cachedTelemetry(garbled, 'k', async () => 'live')).toBe('live');
  });

  it('is a plain read where there is no store', async () => {
    const outcomes: TelemetryCacheOutcome[] = [];
    expect(await cachedTelemetry(null, 'k', async () => 7, { onOutcome: (o) => outcomes.push(o) })).toBe(7);
    expect(outcomes).toEqual(['bypass']);
  });

  it('hands the write to `defer` instead of holding the response for it', async () => {
    const store = memoryStore();
    const deferred: Promise<unknown>[] = [];
    await cachedTelemetry(store, 'k', async () => 1, { defer: (w) => deferred.push(w) });
    expect(deferred).toHaveLength(1);
    await Promise.all(deferred);
    expect(store.entries.size).toBe(1);
  });
});
