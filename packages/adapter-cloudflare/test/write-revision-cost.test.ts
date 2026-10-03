import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { scopeId, type ScopeDumpTable } from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { CloudflareScopeHost } from '../src/host.js';

declare const __PROBE_WRITE_REVISION__: boolean;

/**
 * What #1722's write revision costs (opt in: `SUBSTRAT_PROBE_WRITE_REVISION=1`). The scope DO
 * advances `write_revision` after every statement that can write, so a write statement costs one
 * more single-row UPDATE. Measured on a real DO, from the caller across the RPC: workerd's clock
 * does not move while the object computes, only at I/O, so each sample is one call doing a lot of
 * work, timed by the side that waits for it. Counted and uncounted runs alternate, so drift in
 * the machine lands on both.
 */
describe.skipIf(!__PROBE_WRITE_REVISION__)('the write revision: what it costs (opt in, #1722)', () => {
  type Probe = {
    testWriteBatch(s: string, ops: number, rows: number, counted: boolean): Promise<void>;
    testCountWrites(counted: boolean): Promise<void>;
  };
  const secretBox = webCryptoSecretBox('test-key', new Uint8Array(32).fill(7));
  const stubOf = (sid: string) => env.PC_V1_SCOPE.get(env.PC_V1_SCOPE.idFromName(sid)) as unknown as Probe;
  const host = new CloudflareScopeHost({ scope: env.PC_V1_SCOPE, controlPlane: env.PC_CONTROL_PLANE, secretBox });
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  const timed = async (fn: () => Promise<unknown>) => {
    const start = performance.now();
    await fn();
    return performance.now() - start;
  };
  const report = (name: string, on: number[], off: number[]) => {
    const [a, b] = [median(on), median(off)];
    console.log(`[write-revision] ${name}: counted ${a.toFixed(1)} ms, uncounted ${b.toFixed(1)} ms, overhead ${(((a - b) / b) * 100).toFixed(1)}%`);
  };

  it('a write-heavy operation: 20 inserts, 20 events and 20 updates in one transaction', { timeout: 120_000 }, async () => {
    const sid = scopeId.parse(ulid());
    const stub = stubOf(sid);
    await stub.testWriteBatch(sid, 5, 20, true); // warm the object and the table
    const on: number[] = [];
    const off: number[] = [];
    for (let i = 0; i < 15; i++) {
      on.push(await timed(() => stub.testWriteBatch(sid, 400, 20, true)));
      off.push(await timed(() => stub.testWriteBatch(sid, 400, 20, false)));
    }
    report('400 operations × 60 write statements, each its own run', on, off);
    expect(on.every((t) => t > 0)).toBe(true);
  });

  it('a 200-event drain batch, and its redrain', { timeout: 120_000 }, async () => {
    const sid = scopeId.parse(ulid());
    const ids = Array.from({ length: 200 }, () => ulid());
    const outbox: ScopeDumpTable = {
      name: '_substrat_outbox',
      ddl: 'CREATE TABLE _substrat_outbox (id TEXT PRIMARY KEY)',
      columns: ['id', 'type', 'schema_version', 'occurred_at', 'tenant_id', 'scope_id', 'actor', 'entity_type', 'entity_id', 'pii_class'],
      rows: ids.map((id) => [id, 'bench.wrote', 1, '2026-10-03T00:00:00.000Z', 'tenant', sid, 'actor', 'row', id, 'none']),
    };
    await host.restoreScopeLocal(sid, [outbox]);
    const stub = stubOf(sid);
    const cycle = async () => {
      for (let i = 0; i < 25; i++) {
        await host.markEventsDrainedLocal(sid, ids, '2026-10-03T12:00:00.000Z');
        await host.redrainEventsLocal(sid, '2026-10-04T00:00:00.000Z');
      }
    };
    const on: number[] = [];
    const off: number[] = [];
    for (let i = 0; i < 15; i++) {
      await stub.testCountWrites(true);
      on.push(await timed(cycle));
      await stub.testCountWrites(false);
      off.push(await timed(cycle));
    }
    await stub.testCountWrites(true);
    report('25 × (drain 200 events + redrain them)', on, off);
    expect(on.every((t) => t > 0)).toBe(true);
  });
});
