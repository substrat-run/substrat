/**
 * The Tier-2 drain, end to end over a real host, with one outbox row that will not decode
 * (#1636).
 *
 * The shared contract suite holds each adapter's READ to the skip; the kernel's sweep test
 * holds the REPORT to what a read declares, with a fake host. This is the join between the
 * two — the real `runPlatformSweep` over a real `SqliteScopeHost`, planted the way #1588's
 * were, through a restore of the scope's own export — because each half being right says
 * nothing about the wiring between them.
 *
 * Before #1636 the read threw for the scope on every pass: nothing shipped, including the
 * healthy event behind the bad one, and the sweep's only record was an `event-drain` error.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId, type DrainedEvent } from '@substrat-run/contracts';
import { runPlatformSweep, ulid, webCryptoSecretBox, type OperationHandler } from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

const staff = platformActorId.parse(ulid());
const alice = principalId.parse(ulid());
const BAD = '00000000000000000000000000';
const FETCH = (() => Promise.reject(new Error('no fetch in this test'))) as never;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function plantedScope(planted: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-event-drain-skip-'));
  dirs.push(dir);
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)) });
  host.defineOperation('probe/emit', ((ctx) => {
    ctx.emit({
      type: 'probe.happened',
      schemaVersion: 1,
      entity: { entityType: 'probe', entityId: 'p1' },
      piiClass: 'none',
      payload: { ok: true },
    });
  }) as OperationHandler<never, unknown>);
  await host.admin.createTenant(staff, { id: t, slug: `drain-skip-${ulid().toLowerCase()}`, name: 'Drain skip' });
  await host.provisionScope(staff, { tenantId: t, scopeId: s });
  await host.admin.activateScope(staff, t, s);
  await (await host.getScope(alice, t, s)).invoke('probe/emit');

  const dump = await host.admin.exportScope(staff, t, s);
  const outbox = dump.tables.find((x) => x.name === '_substrat_outbox')!;
  const healthy = outbox.rows.find((r) => (r as unknown[])[outbox.columns.indexOf('type')] === 'probe.happened') as unknown[];
  expect(healthy).toBeDefined();
  const healthyId = String(healthy[outbox.columns.indexOf('id')]);
  if (planted) {
    const bad = [...healthy];
    bad[outbox.columns.indexOf('id')] = BAD;
    bad[outbox.columns.indexOf('actor')] = '{';
    await host.restoreScope(staff, t, s, {
      ...dump,
      tables: dump.tables.map((x) => (x === outbox ? { ...x, rows: [bad, ...x.rows] } : x)),
    });
  }
  return { host, t, s, healthyId };
}

function sink() {
  const shipped: DrainedEvent[] = [];
  return { shipped, eventSink: { ship: async (_: unknown, events: DrainedEvent[]) => (shipped.push(...events), { ref: 'lake' }) } };
}
const sweep = (host: SqliteScopeHost, eventSink: ReturnType<typeof sink>['eventSink']) =>
  runPlatformSweep(host, { actor: staff, fetch: FETCH, sweepers: {}, drainRetries: false, eventSink });

describe('the Tier-2 drain over a real host, one undecodable row (#1636)', () => {
  it('ships and stamps the event behind it, and reports the skip — pass after pass', async () => {
    const { host, t, s, healthyId } = await plantedScope(true);
    const lake = sink();

    const first = await sweep(host, lake.eventSink);
    expect(lake.shipped.map((e) => e.id)).toContain(healthyId);
    expect(lake.shipped.map((e) => e.id)).not.toContain(BAD);
    expect(first.eventDrain!.skipped).toEqual([{ tenantId: t, scopeId: s, count: 1, eventIds: [BAD] }]);
    expect(first.errors.filter((e) => e.kind === 'event-drain')).toEqual([]);

    // The healthy row is stamped, the bad one is not: it never left, and the stamp says so.
    const after = await host.admin.readUndrainedEvents(staff, t, s, 200);
    expect(after.map((e) => e.id)).not.toContain(healthyId);
    expect(after.skipped).toEqual({ count: 1, eventIds: [BAD] });

    // The cost of the skip, visible every pass until the row is repaired: nothing ships,
    // and the report says it again rather than going quiet.
    const again = sink();
    const second = await sweep(host, again.eventSink);
    expect(again.shipped).toEqual([]);
    expect(second.eventDrain!.skipped).toEqual([{ tenantId: t, scopeId: s, count: 1, eventIds: [BAD] }]);
  });

  it('a clean scope drains with no `skipped` in the report — the positive twin', async () => {
    const { host, healthyId } = await plantedScope(false);
    const lake = sink();
    const report = await sweep(host, lake.eventSink);
    expect(lake.shipped.map((e) => e.id)).toContain(healthyId);
    expect(report.eventDrain).not.toHaveProperty('skipped');
  });
});
