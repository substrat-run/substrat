/**
 * K-69, step 4.2 (#3376): a connection's sweep, driven by that connection's own alarm
 * (`src/connection-sweep-do.ts`). The object decides only when; `test/worker.ts`'s run records that it
 * ran and answers what the test wrote for it.
 */
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ulid } from '@substrat-run/kernel';
import { connectionSweepName, spreadOf, type ConnectionSweepDo, type ConnectionSweepRef } from '../src/connection-sweep-do.js';

const log = () => env.KICK_LOG.get(env.KICK_LOG.idFromName('log')) as unknown as { record(l: string): Promise<void>; lines(): Promise<string[]> };
const runsOf = async (id: string) => (await log().lines()).filter((l) => l === `run:${id}`).length;
const objectOf = (ns: DurableObjectNamespace, id: string) => ns.get(ns.idFromName(connectionSweepName(id)));
const ensure = (stub: DurableObjectStub, ref: ConnectionSweepRef) => (stub as unknown as ConnectionSweepDo).ensure(ref);
const refOf = (id: string): ConnectionSweepRef => ({ id, tenantId: ulid(), vertical: 'crm', provider: 'acme' });
const storageOf = (stub: DurableObjectStub) =>
  runInDurableObject(stub, async (_i, state) => ({ keys: [...(await state.storage.list()).keys()], alarm: await state.storage.getAlarm() }));
const MIN = 60_000;

describe("a connection's own sweep object (K-69, step 4.2)", () => {
  it('the check arms the first run without running it, the alarm runs it and re-arms, and a gone connection clears it', async () => {
    const id = ulid();
    const stub = objectOf(env.CONNECTION_SWEEP_TEST, id);
    const before = Date.now();
    expect(await ensure(stub, refOf(id))).toBe('started');
    // Armed for the first delay (a minute here), and nothing ran inside the check.
    const first = (await storageOf(stub)).alarm!;
    expect(first - before).toBeGreaterThanOrEqual(MIN - 1_000);
    expect(await runsOf(id)).toBe(0);
    expect(await ensure(stub, refOf(id))).toBe('held');

    // A plain run re-arms at the interval (ten minutes here) from its end.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const ended = Date.now();
    expect(await runsOf(id)).toBe(1);
    const next = (await storageOf(stub)).alarm!;
    expect(next - ended).toBeGreaterThanOrEqual(10 * MIN - 5_000);
    expect(next - ended).toBeLessThanOrEqual(10 * MIN);

    // A run the sweep waited out arms at the time it said; one that throws, at the interval.
    const notBefore = Date.now() + 90 * MIN;
    await log().record(`answer:${id}=notBefore:${notBefore}`);
    await runDurableObjectAlarm(stub);
    expect((await storageOf(stub)).alarm).toBe(notBefore);
    await log().record(`answer:${id}=throw`);
    await runDurableObjectAlarm(stub);
    expect((await storageOf(stub)).alarm! - Date.now()).toBeGreaterThan(9 * MIN);
    expect(await runsOf(id)).toBe(3);

    // Revoked or gone: nothing is kept at rest (D-79).
    await log().record(`answer:${id}=gone`);
    await runDurableObjectAlarm(stub);
    expect(await storageOf(stub)).toEqual({ keys: [], alarm: null });
  });

  it('an object whose deployment handed the sweep back clears on its alarm without running', async () => {
    const id = ulid();
    const stub = objectOf(env.CONNECTION_SWEEP_UNOWNED, id);
    expect(await ensure(stub, refOf(id))).toBe('started');
    await runDurableObjectAlarm(stub);
    expect(await runsOf(id)).toBe(0);
    expect(await storageOf(stub)).toEqual({ keys: [], alarm: null });
  });

  it('refuses a check for another connection than the one it sweeps', async () => {
    const id = ulid();
    const stub = objectOf(env.CONNECTION_SWEEP_TEST, id);
    await ensure(stub, refOf(id));
    await expect(() => ensure(stub, refOf(ulid()))).rejects.toThrow(/sweeps connection/);
  });

  it('spreads first runs over the window by id, the same way every time', () => {
    const spread = 5 * MIN;
    const ids = Array.from({ length: 50 }, () => ulid());
    const at = ids.map((i) => spreadOf(i, spread));
    expect(at.every((ms) => ms >= 0 && ms < spread)).toBe(true);
    expect(new Set(at).size).toBeGreaterThan(40);
    expect(ids.map((i) => spreadOf(i, spread))).toEqual(at);
  });
});
