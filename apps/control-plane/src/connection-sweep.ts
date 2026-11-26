/**
 * K-69 (no scheduled walk over tenants), step 4.2 (rfc/tenant-scale.md §7.4, §8.8, §12; #3376): the
 * connector sweep driven by each connection's own alarm (`ConnectionSweepDO`,
 * `defineConnectionSweepDO` in adapter-cloudflare), and the `*\/15` pass only checking that nothing
 * was left.
 *
 * One switch, `CONNECTOR_SWEEP_OWNER`: `connection` hands every connection's sweep to its own object;
 * unset (the default) or `pass` keeps today's phase, run last in the pass (#3324). It reverts by
 * unsetting it: each object clears on its next wake without sweeping, and the pass sweeps again.
 *
 * With the switch on, a connection's object runs the pass's own `runConnectorSweep` for that one
 * connection, so its attempt rows, crash back-off, per-connection budget, landings and the operator's
 * pause (`CONNECTOR_SWEEP_PAUSED`) are unchanged. What changes:
 * - one connection's sweep is its own invocation, so a slow or failing one holds no other behind it;
 * - a connection is swept at its provider's interval (`sweepEveryMinutes`, else 15 minutes) from its
 *   own last sweep, and waited out by its own back-off without waking the pass;
 * - the pass calls each live connection's object once (`ensure`), which arms the alarm if nothing is
 *   armed and never runs the sweep itself. What it found is the `connector-wake-check` log line of
 *   every checked pass: `held` (armed, on time), `started` (nothing was armed: the check armed it),
 *   `overdue` (armed for more than an hour ago: armed for now), `fallback` (the object could not be
 *   reached: the pass swept that connection itself, as before).
 *
 * The pass's walk over connections stays in this phase: replacing it with the safety net's query
 * over a due index is the follow-up, once `started` has been watched at zero.
 */
import { tenantId as tenantIdSchema, type Connection, type PlatformActorId } from '@substrat-run/contracts';
import { runConnectorSweep, type ConnectorSweepOptions, type ConnectorSweepReport, type ScopeHost } from '@substrat-run/kernel';
import { connectionSweepName, type ConnectionSweepCheck, type ConnectionSweepDo, type ConnectionSweepRef, type ConnectionSweepRun } from '@substrat-run/adapter-cloudflare';

/** Who sweeps the connections: the pass's phase, or each connection's own object. */
export type ConnectorSweepOwner = 'pass' | 'connection';

/**
 * `CONNECTOR_SWEEP_OWNER` → who sweeps. `connection` only where the object's namespace is bound; a
 * word it does not know is warned about and leaves the sweep with the pass, the safe side.
 */
export function connectorSweepOwnerOf(raw: string | undefined, bound: boolean): ConnectorSweepOwner {
  const word = (raw ?? '').trim();
  if (word === '' || word === 'pass') return 'pass';
  if (word !== 'connection') {
    console.warn(`CONNECTOR_SWEEP_OWNER: '${word}' is not pass or connection; ignored, the pass sweeps`);
    return 'pass';
  }
  return bound ? 'connection' : 'pass';
}

/** What the pass's check found across one pass: the `connector-wake-check` log line. */
export interface ConnectorWakeCheck {
  held: number;
  started: number;
  overdue: number;
  fallback: number;
}

/** The address an object is handed: what it needs to read its connection back. */
export const connectionSweepRefOf = (c: Connection): ConnectionSweepRef => ({ id: c.id, tenantId: c.tenantId, vertical: c.vertical, provider: c.provider });

/** How many objects the check asks at once. */
const CHECK_CONCURRENCY = 8;

/**
 * The pass's check: make sure each live connection's object is armed. Answers the tally, and the
 * connections whose object could not be reached, for the pass to sweep itself.
 */
export async function checkConnectionSweeps(
  ns: DurableObjectNamespace,
  connections: readonly Connection[],
): Promise<{ check: ConnectorWakeCheck; fallback: Connection[] }> {
  const check: ConnectorWakeCheck = { held: 0, started: 0, overdue: 0, fallback: 0 };
  const fallback: Connection[] = [];
  const live = connections.filter((c) => c.revokedAt === null);
  let next = 0;
  const worker = async () => {
    while (next < live.length) {
      const c = live[next++]!;
      let found: ConnectionSweepCheck;
      try {
        const stub = ns.get(ns.idFromName(connectionSweepName(c.id))) as unknown as ConnectionSweepDo;
        found = await stub.ensure(connectionSweepRefOf(c));
      } catch (err) {
        console.warn('connector wake check: the connection object could not be reached; the pass sweeps it', { connectionId: c.id, err });
        check.fallback += 1;
        fallback.push(c);
        continue;
      }
      check[found] += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, live.length) }, worker));
  return { check, fallback };
}

export interface OwnConnectionSweepDeps {
  host: ScopeHost;
  actor: PlatformActorId;
  /** The pass's own connector sweep options (`connectorSweepOptionsFor` in worker.ts). */
  options: ConnectorSweepOptions;
  /** Every ledger write the sweep made, landed before the run ends (`pendingWrites().settle`). */
  settle(): Promise<void>;
}

/**
 * One run of one connection's sweep, from its object's alarm: the pass's `runConnectorSweep` over
 * that one connection, read back from the directory so a revoke since the last run is seen. Its
 * reads are one access-log summary row, as the pass's are (K-73).
 */
export async function sweepOwnConnection(deps: OwnConnectionSweepDeps, ref: ConnectionSweepRef): Promise<ConnectionSweepRun> {
  const { host, actor } = deps;
  await host.admin.summarizeAccess?.(actor);
  try {
    const rows = await host.admin.listConnections(actor, {
      tenantId: tenantIdSchema.parse(ref.tenantId),
      vertical: ref.vertical,
      provider: ref.provider,
      includeRevoked: true,
    });
    const connection = rows.find((c) => c.id === ref.id);
    if (!connection || connection.revokedAt !== null) return { gone: true };
    let notBefore: number | undefined;
    let report: ConnectorSweepReport;
    try {
      report = await runConnectorSweep(host, {
        ...deps.options,
        connections: [connection],
        concurrency: 1,
        onNextAttempt: (_id, at) => {
          notBefore = at;
        },
      });
    } finally {
      // The outcome row must land before the run ends: one dropped reads to the next run as a crash.
      await deps.settle();
    }
    if (report.errors.length > 0 || report.connectionsPaused > 0 || report.connectionsBackingOff > 0) {
      console.log('connector-sweep', { connectionId: ref.id, ...report });
    }
    const everyMinutes = deps.options.sweepEveryMinutes?.[connection.provider];
    return {
      ...(notBefore !== undefined ? { notBefore } : {}),
      ...(everyMinutes ? { intervalMs: everyMinutes * 60_000 } : {}),
    };
  } finally {
    try {
      await host.admin.flushAccessSummary?.(actor);
    } catch (err) {
      console.error('connection sweep: the access summary could not be written', err instanceof Error ? err.message : String(err));
    }
  }
}
