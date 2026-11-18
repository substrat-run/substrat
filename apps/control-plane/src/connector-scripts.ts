import {
  connectionProbe,
  connectorCallResponse,
  connectorScriptName,
  instant,
  tenantId as tenantIdSchema,
  type Connection,
  type ConnectionProbe,
  type ConnectionUseOutcomeWire,
  type ConnectorCallTransportResult,
  type ConnectorScriptCallRequest,
} from '@substrat-run/contracts';
import { globalFetch, settleConnectionUse, type FetchLike, type ScopeHost } from '@substrat-run/kernel';

/**
 * A first-party connector run as its own deployed script (docs/rfc/connector-scripts.md, phase 1).
 *
 * A PILOT, behind `REMOTE_CONNECTORS`, test environment only. With the flag unset — every
 * environment today — nothing here runs and a connector is called in-process exactly as before.
 * With a provider named in it, that provider's probes are made through the router's
 * `ConnectorCalls.callScript` into `substrat-connector-<provider>`, over D-64's call contract: the
 * credential and the configuration travel in the call, the script answers a probe and the uses it
 * made, and the control plane records the uses against the connection it opened.
 */

/** The router's `ConnectorCalls` entrypoint, the half of it this module calls. */
export interface ConnectorScriptCallsBinding {
  callScript?(target: unknown, request: unknown): Promise<ConnectorCallTransportResult>;
}

export interface ConnectorScriptEnv {
  /**
   * Providers whose calls go to their own script, comma-separated (`bolagsverket`). Unset or empty
   * runs every connector in-process. A provider with no script registration is ignored.
   */
  REMOTE_CONNECTORS?: string;
  /**
   * The hop probe, opt-in and never part of a gate: providers whose probes are run BOTH ways, in a
   * random order, with one `connector-hop-probe` log line per call comparing the two. The answer
   * the person sees is still the one `REMOTE_CONNECTORS` places; the other is a shadow, which
   * calls the provider but records no use. Set it in TEST only, for as long as a measurement takes.
   */
  PROBE_CONNECTOR_HOP?: string;
  CONNECTOR_CALLS?: ConnectorScriptCallsBinding;
}

const listed = (value: string | undefined, provider: string): boolean =>
  (value ?? '').split(',').map((p) => p.trim()).includes(provider);

/** Whether `provider`'s calls go to its script in this environment. */
export function runsAsScript(env: ConnectorScriptEnv, provider: string): boolean {
  return listed(env.REMOTE_CONNECTORS, provider);
}

/** The two probes, as a registration hands them over. */
export interface ConnectorProbes {
  probe(host: ScopeHost, connection: Connection): Promise<ConnectionProbe>;
  probeCandidate(secret: Record<string, string>): Promise<ConnectionProbe>;
}

/**
 * What a connector that can run as a script registers, beside its in-process code. `local` takes
 * the `fetch` the provider is called through, so the hop probe can time the provider's share.
 */
export interface ConnectorScriptSpec {
  readonly provider: string;
  /** The in-process probes, exactly as the registration makes them without a script. */
  local(fetch: FetchLike): ConnectorProbes;
  /** The configuration a call carries, from this environment's vars. */
  config(): Record<string, string>;
  /** The hosts the script's egress admits for a call under {@link config}. */
  hosts(): string[];
}

const ERROR_MAX = 600;
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const failure = (error: string, refused = false): ConnectionProbe => ({
  ok: false,
  refused,
  accountRef: null,
  accountLabel: null,
  facts: [],
  error: error.slice(0, ERROR_MAX),
});

/**
 * One call, timed and not yet persisted: the probe, the control plane's wall clock, the share the
 * provider's calls took, and the uses those calls made. Nothing is recorded while the clock runs:
 * persisting the uses is the caller's step, after it, so the hop probe compares the same work.
 */
interface Timed {
  probe: ConnectionProbe;
  totalMs: number;
  providerMs: number;
  uses: ConnectionUseOutcomeWire[];
}

/** The tenant's live connection of this provider — the row the in-process probe opens — and its credential as strings. */
async function openFor(host: ScopeHost, connection: Connection, provider: string) {
  const open = await host.admin.openConnection(tenantIdSchema.parse(connection.tenantId), connection.vertical, provider);
  if (!open) return { ok: false, refused: `no live '${provider}' connection for tenant ${connection.tenantId} / vertical '${connection.vertical}'` } as const;
  const secret: Record<string, string> = {};
  for (const [key, value] of Object.entries(open.secret as Record<string, unknown>)) {
    if (typeof value !== 'string') return { ok: false, refused: `the stored credential holds a non-string value under '${key}'` } as const;
    secret[key] = value;
  }
  return { ok: true, open, secret } as const;
}
type Opened = Extract<Awaited<ReturnType<typeof openFor>>, { ok: true }>;

/** One call into the script, timed. Records nothing. */
async function callScript(env: ConnectorScriptEnv, spec: ConnectorScriptSpec, tenantId: string | null, request: ConnectorScriptCallRequest): Promise<Timed> {
  const started = Date.now();
  const done = (probe: ConnectionProbe, uses: ConnectionUseOutcomeWire[] = []): Timed => ({
    probe,
    totalMs: Date.now() - started,
    providerMs: uses.reduce((sum, u) => sum + (u.durationMs ?? 0), 0),
    uses,
  });
  const calls = env.CONNECTOR_CALLS;
  // Called as a method on the binding, never lifted off it: an RPC stub's method is a proxy.
  if (!calls?.callScript) return done(failure(`${spec.provider} runs as a script here, and this control plane has no route to it (CONNECTOR_CALLS.callScript)`));
  let answer: ConnectorCallTransportResult;
  try {
    answer = await calls.callScript({ script: connectorScriptName(spec.provider), tenantId, hosts: spec.hosts() }, request);
  } catch (e) {
    return done(failure(`the ${spec.provider} connector script did not answer: ${message(e)}`));
  }
  // A refusal of the call itself is the platform's failure, never the tenant's credential.
  if (answer.status !== 200) {
    const detail = (answer.body as { error?: unknown } | null)?.error;
    return done(failure(`the ${spec.provider} connector script answered HTTP ${answer.status}${typeof detail === 'string' ? `: ${detail}` : ''}`));
  }
  const parsed = connectorCallResponse.safeParse(answer.body);
  if (!parsed.success) return done(failure(`the ${spec.provider} connector script answered something that is not a connector-call response`));
  const response = parsed.data;
  if (!response.ok) return done(failure(response.error, response.refused), response.uses);
  // Phase 1 carries no connector state, so a script that writes some is not one this plane runs.
  if (response.state.length > 0) return done(failure(`the ${spec.provider} connector script wrote connector state, which a probe never does`), response.uses);
  const probe = connectionProbe.safeParse(response.result);
  return done(probe.success ? probe.data : failure(`the ${spec.provider} connector script answered a probe that does not read as one`), response.uses);
}

/** A stored connection's probe through the script, for an opened row. Records nothing. */
function scriptProbe(env: ConnectorScriptEnv, spec: ConnectorScriptSpec, connection: Connection, { open, secret }: Opened): Promise<Timed> {
  return callScript(env, spec, connection.tenantId, {
    role: 'probe',
    provider: spec.provider,
    connection: {
      id: open.id,
      tenantId: connection.tenantId,
      vertical: connection.vertical,
      provider: spec.provider,
      externalAccountRef: connection.externalAccountRef,
      expiresAt: open.expiresAt === null ? null : instant.parse(open.expiresAt),
      secret,
    },
    state: [],
    config: spec.config(),
  });
}

const scriptCandidate = (env: ConnectorScriptEnv, spec: ConnectorScriptSpec, secret: Record<string, string>): Promise<Timed> =>
  // No connection exists yet, so no tenant is metered and there is nothing to record against.
  callScript(env, spec, null, { role: 'probe-candidate', provider: spec.provider, secret, config: spec.config() });

/**
 * One in-process probe of a credential, timed: the connector's candidate probe over a `fetch` that
 * times each provider call and collects it as a use, exactly as the script reports its own. Records
 * nothing, like the script side.
 */
async function localCandidate(spec: ConnectorScriptSpec, secret: Record<string, string>): Promise<Timed> {
  const uses: ConnectionUseOutcomeWire[] = [];
  let providerMs = 0;
  const timed: FetchLike = async (input, init) => {
    const started = Date.now();
    const settle = (settled: Parameters<typeof settleConnectionUse>[2]) => {
      const ms = Math.max(0, Date.now() - started);
      providerMs += ms;
      const use = settleConnectionUse(spec.provider, ms, settled);
      uses.push(use.ok ? use : { ...use, error: use.error.slice(0, ERROR_MAX) });
    };
    try {
      const response = await globalFetch(input, init);
      settle({ response });
      return response;
    } catch (error) {
      settle({ error });
      throw error;
    }
  };
  const started = Date.now();
  const probe = await spec.local(timed).probeCandidate(secret);
  return { probe, totalMs: Date.now() - started, providerMs, uses };
}

/**
 * The probes a registration hands over for `spec.provider`: in-process, or through its script,
 * as {@link runsAsScript} says, and both ways at once under the hop probe.
 */
export function placedProbes(env: ConnectorScriptEnv, spec: ConnectorScriptSpec): ConnectorProbes {
  const remote = runsAsScript(env, spec.provider);
  if (!listed(env.PROBE_CONNECTOR_HOP, spec.provider)) {
    if (!remote) return spec.local(globalFetch);
    return {
      probe: async (host, connection) => {
        try {
          const opened = await openFor(host, connection, spec.provider);
          if (!opened.ok) return failure(opened.refused);
          const { probe, uses } = await scriptProbe(env, spec, connection, opened);
          for (const use of uses) await host.admin.recordConnectionUse(opened.open.id, use);
          return probe;
        } catch (e) {
          return failure(`the probe could not run: ${message(e)}`);
        }
      },
      probeCandidate: async (secret) => (await scriptCandidate(env, spec, secret)).probe,
    };
  }

  /**
   * The hop probe. Both samples do the same work and only that work: one provider round over an
   * already-opened credential, timed, with its uses collected and nothing persisted. Once both
   * clocks have stopped, the placed side's uses are recorded against the connection, so health
   * reads as one probe and its write latency is in neither sample.
   */
  const compare = async (
    role: 'probe' | 'probe-candidate',
    inProcess: () => Promise<Timed>,
    viaScript: () => Promise<Timed>,
    persist: (uses: ConnectionUseOutcomeWire[]) => Promise<void>,
  ): Promise<ConnectionProbe> => {
    const scriptFirst = Math.random() < 0.5;
    const first = await (scriptFirst ? viaScript() : inProcess());
    const second = await (scriptFirst ? inProcess() : viaScript());
    const [script, local] = scriptFirst ? [first, second] : [second, first];
    console.log(
      JSON.stringify({
        connector: 'connector-hop-probe',
        provider: spec.provider,
        role,
        answeredBy: remote ? 'script' : 'in-process',
        order: scriptFirst ? 'script-first' : 'in-process-first',
        inProcess: { totalMs: local.totalMs, providerMs: local.providerMs, ok: local.probe.ok, refused: local.probe.refused },
        script: { totalMs: script.totalMs, providerMs: script.providerMs, ok: script.probe.ok, refused: script.probe.refused },
        // What the hop costs: the wall clock beyond the provider's own share, script minus in-process.
        hopMs: script.totalMs - script.providerMs - (local.totalMs - local.providerMs),
        agree: local.probe.ok === script.probe.ok && local.probe.refused === script.probe.refused,
      }),
    );
    const placed = remote ? script : local;
    await persist(placed.uses);
    return placed.probe;
  };
  return {
    probe: async (host, connection) => {
      try {
        // Opened once, before either clock starts: both samples probe the same credential.
        const opened = await openFor(host, connection, spec.provider);
        if (!opened.ok) return failure(opened.refused);
        return await compare(
          'probe',
          () => localCandidate(spec, opened.secret),
          () => scriptProbe(env, spec, connection, opened),
          async (uses) => {
            for (const use of uses) await host.admin.recordConnectionUse(opened.open.id, use);
          },
        );
      } catch (e) {
        return failure(`the probe could not run: ${message(e)}`);
      }
    },
    probeCandidate: (secret) =>
      compare('probe-candidate', () => localCandidate(spec, secret), () => scriptCandidate(env, spec, secret), async () => {}),
  };
}
