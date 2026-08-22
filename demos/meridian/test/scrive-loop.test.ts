import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Page } from '@substrat-run/contracts';
import { platformActorId, type ScopeId } from '@substrat-run/contracts';
import { runPlatformSweep, ulid } from '@substrat-run/kernel';
import { ScriveMock, sweepScriveReconciliations } from '@substrat-run/connector-scrive';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import type { ProtocolSummary } from '@substrat-run/engine-protocol';
import { buildDemoHost, seedDemo, type DemoWorld, type ScriveCredential } from '../src/index.js';

/**
 * Gate 1, end to end: with the Scrive connector wired into the vertical and the
 * platform sweeper as its timer, a completed signature travels all the way back
 * onto the protocol instance — nobody handing the reconcile an instance id.
 *
 * The whole loop runs against `ScriveMock`: the vertical issues Karin's
 * anställningsavtal → the connector dispatches it to Scrive → the parties sign at
 * the provider (the mock stands in for the browser/BankID step we cannot cause) →
 * `runPlatformSweep` (what `startPlatformSweeper` calls on a timer) reconciles it
 * back and the instance goes `signed`.
 *
 * What this proves that the connector's own tests do not: the reference vertical
 * really registers the connector, opens a connection with the right grant, and
 * that the sweeper — driven exactly as the server drives it — closes the loop.
 */
describe('Meridian — Scrive signature loop (Gate 1)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let mock: ScriveMock;
  let world: DemoWorld;

  const SECRET: ScriveCredential = { clientId: 'ci', clientSecret: 'cs', tokenId: 'ti', tokenSecret: 'ts' };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'meridian-scrive-'));
    mock = new ScriveMock();
    // Scrive enabled with the mock as egress — the exact shape server.ts builds.
    host = buildDemoHost(dir, { fetch: mock.fetch, secret: SECRET });
    world = await seedDemo(host, dir, SECRET);
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Karin's employment contract summary, read as the HR admin. */
  const karinsContract = async (): Promise<ProtocolSummary> => {
    const hedda = await host.getScope(world.hedda, world.t1, world.sSe);
    const { entries: list } = await hedda.invoke<Page<ProtocolSummary>>(
      'protocol/list-for-entity',
      { entityType: 'employee', entityId: world.karinEmpId },
    );
    const contract = list.find((p) => p.contentKind === 'document');
    if (!contract) throw new Error('no document protocol on Karin');
    return contract;
  };

  const sweep = () =>
    runPlatformSweep(host, {
      actor: platformActorId.parse(ulid()),
      fetch: mock.fetch,
      sweepers: { scrive: sweepScriveReconciliations },
    });

  it('dispatches the contract to Scrive during seeding', () => {
    // Seeding issued Karin's contract; the connector turned it into a started
    // Scrive document (create → setfile → update → start).
    expect(mock.documents.size).toBe(1);
    const [doc] = [...mock.documents.values()];
    expect(doc!.status).toBe('pending');
    // #852: party 0 is the SENDER — the Scrive account, which does not sign and whose
    // identity the provider stamps on regardless of what we send. The two named
    // parties follow it and keep their own.
    expect(doc!.parties.map((p) => [p.name, p.isSignatory])).toEqual([
      ['Mock Operator', false],
      ['Arbetsgivare', true],
      ['Anställd', true],
    ]);
  });

  it('leaves the contract pending until the parties actually sign', async () => {
    const before = await karinsContract();
    expect(before.instance.status).toBe('pending_signature');
    // A sweep with nothing signed records nothing and does not complete it.
    const idle = await sweep();
    expect(idle.errors).toEqual([]);
    expect((await karinsContract()).instance.status).toBe('pending_signature');
  });

  it('records both signatures and marks the contract signed once they sign', async () => {
    const [doc] = [...mock.documents.values()];
    // The provider-side event we cannot cause for real: both parties complete.
    mock.sign(doc!.id, 1, '2026-08-01T09:00:00.000Z');
    mock.sign(doc!.id, 2, '2026-08-01T10:30:00.000Z');

    const report = await sweep();
    expect(report.errors).toEqual([]);
    // Two: the demo world has two tenants, and since #687 every Meridian instance
    // holds a Scrive connection — a contract cannot be issued without one, because
    // the request seals each signatory's address to its public key. The second
    // tenant's is a placeholder with nothing out for signature, so it sweeps clean.
    expect(report.connectionsSwept).toBe(2);

    // The signature travelled back onto the instance — the whole point of Gate 1.
    const after = await karinsContract();
    expect(after.instance.status).toBe('signed');

    // Idempotent: a re-sweep of the settled contract records nothing new and does
    // not error (the connection is still swept, it just finds nothing to do).
    const again = await sweep();
    expect(again.errors).toEqual([]);
    expect((await karinsContract()).instance.status).toBe('signed');
  });

  it('attributes the signatures to the connection, not a human role', async () => {
    // The write-back authority was the connection's own `protocol:record-signature`
    // grant (connectScrive), so a scope with that connection recorded a signature
    // whose method is the provider's — proof the #97 seam, not test scaffolding,
    // carried it.
    const scope: ScopeId = world.sSe;
    // Narrowed to the tenant under test: every Meridian instance now holds a
    // connection (#687), so the fleet-wide list is no longer a statement about
    // this one.
    const conns = await host.admin.listConnections(platformActorId.parse(ulid()), {
      tenantId: world.t1,
      provider: 'scrive',
    });
    expect(conns.map((c) => c.vertical)).toEqual(['meridian']);
    expect(conns.every((c) => c.tenantId === world.t1)).toBe(true);
    expect(scope).toBe(world.sSe);
  });
});
