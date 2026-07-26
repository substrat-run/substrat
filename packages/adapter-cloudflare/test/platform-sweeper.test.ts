import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { connectionId, platformActorId, tenantId } from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox, type PlatformSweepReport } from '@substrat-run/kernel';
import { CloudflareScopeHost } from '../src/host.js';
import { PLATFORM_SWEEPER_NAME, type PlatformSweepOutcome } from '../src/platform-sweeper-do.js';
import { warmControlPlane } from './do-warmup.js';

/**
 * The TRIGGER path, exercised for real: a workerd Durable Object alarm driving
 * the kernel's `runPlatformSweep` (a black box here — its phases have their own
 * tests in the kernel) against the same live SCOPE/CONTROL_PLANE bindings the
 * contract suites use. What these tests own is the loop's contract:
 *
 *   - a kick (`sweepNow`) runs a real pass and ARMS the alarm (the loop starts)
 *   - the alarm runs a pass and re-arms itself (the loop continues)
 *   - `ensureArmed` is idempotent — it never moves a set alarm
 *   - two concurrent kicks share ONE pass (non-overlap, `startPlatformSweeper`'s
 *     guarantee, kept by this trigger too)
 *   - a pass that sinks whole still re-arms (the loop never dies)
 *
 * The pass itself is the one wired in test/worker.ts: two fake connector
 * sweepers, `sweep-test` (counts passes in durable connector state) and
 * `sweep-boom` (always throws).
 */

/** The RPC surface `definePlatformSweeperDO` classes expose over a stub. */
interface SweeperStub {
  ensureArmed(): Promise<{ armed: boolean; alarmAt: number }>;
  sweepNow(): Promise<PlatformSweepOutcome>;
}

const sweeperStub = (ns: DurableObjectNamespace): DurableObjectStub & SweeperStub =>
  ns.get(ns.idFromName(PLATFORM_SWEEPER_NAME)) as DurableObjectStub & SweeperStub;

const alarmOf = (stub: DurableObjectStub): Promise<number | null> =>
  runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());

describe('definePlatformSweeperDO (workerd alarm → runPlatformSweep)', () => {
  const staff = platformActorId.parse(ulid());
  const t1 = tenantId.parse(ulid());
  const swept = connectionId.parse(ulid()); // provider 'sweep-test' — counted
  const boom = connectionId.parse(ulid()); // provider 'sweep-boom' — throws

  // The sweeper tests' OWN namespaces — never the contract suites' singleton
  // (see the wrangler.jsonc comment on SWEEP_CONTROL_PLANE).
  const host = () =>
    new CloudflareScopeHost({
      scope: env.SWEEP_SCOPE,
      controlPlane: env.SWEEP_CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });

  const sweepCount = async (): Promise<number> =>
    ((await host().admin.getConnectorState(swept, 'sweeps')) as number | undefined) ?? 0;

  beforeAll(async () => {
    await warmControlPlane(env.SWEEP_CONTROL_PLANE); // absorb the inter-file DO reload
    const admin = host().admin;
    await admin.createTenant(staff, { id: t1, slug: `sweep-${ulid().toLowerCase()}`, name: 'Sweep Trigger AB' });
    await admin.createConnection(staff, {
      id: swept,
      tenantId: t1,
      vertical: 'sweep-vertical',
      provider: 'sweep-test',
      label: 'counting provider',
      secret: { accessToken: 'tok-sweep' },
    });
    await admin.createConnection(staff, {
      id: boom,
      tenantId: t1,
      vertical: 'sweep-vertical',
      provider: 'sweep-boom',
      label: 'exploding provider',
      secret: { accessToken: 'tok-boom' },
    });
  });

  it('a kick runs a real pass — and arms the alarm, starting the loop', async () => {
    const stub = sweeperStub(env.SWEEPER);
    expect(await alarmOf(stub)).toBeNull(); // nothing armed it yet

    const outcome = await stub.sweepNow();
    if ('error' in outcome) throw new Error(`the pass sank whole: ${outcome.error}`);
    const report: PlatformSweepReport = outcome;

    // The real runPlatformSweep ran against the real directory: OUR counting
    // connection was swept (durably — read back through a fresh host), the
    // exploding one is an isolated error, and neither sank the pass.
    expect(report.connectionsSwept).toBe(1);
    expect(await sweepCount()).toBe(1);
    expect(report.errors).toEqual([{ kind: 'sweep', id: boom, error: 'provider exploded' }]);

    // A kick also (re)starts the loop.
    expect(await alarmOf(stub)).not.toBeNull();
  });

  it('ensureArmed never moves an alarm that is already set', async () => {
    const stub = sweeperStub(env.SWEEPER);
    const first = await stub.ensureArmed();
    expect(first.armed).toBe(false); // sweepNow above already armed it
    const second = await stub.ensureArmed();
    expect(second).toEqual(first);
  });

  it('the alarm runs a pass and re-arms itself', async () => {
    const stub = sweeperStub(env.SWEEPER);
    const before = await sweepCount();

    expect(await runDurableObjectAlarm(stub)).toBe(true); // a scheduled alarm ran
    expect(await sweepCount()).toBe(before + 1);

    const next = await alarmOf(stub);
    expect(next).not.toBeNull(); // the loop continues…
    expect(next!).toBeGreaterThan(Date.now()); // …a full gap in the future
  });

  it('two concurrent kicks share one pass — never overlap', async () => {
    const stub = sweeperStub(env.SWEEPER);
    const before = await sweepCount();

    // `sweep-test` holds its pass open for 25ms, so the second kick arrives
    // mid-pass and must JOIN it rather than start a second one.
    const [a, b] = await Promise.all([stub.sweepNow(), stub.sweepNow()]);

    expect(await sweepCount()).toBe(before + 1); // one pass, not two
    expect(a).toEqual(b); // both callers observed the same settled pass
  });

  it('a pass that sinks whole is reported — and the loop survives, re-armed', async () => {
    const stub = sweeperStub(env.BROKEN_SWEEPER);

    expect(await stub.sweepNow()).toEqual({ error: 'the directory is unreachable' });
    expect(await alarmOf(stub)).not.toBeNull(); // still armed after a total failure

    // The alarm path survives it too: the handler swallows the throw (so workerd
    // never retries on its own tightened schedule) and re-arms at the interval.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await alarmOf(stub)).not.toBeNull();
  });
});
