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
import { globalFetch, type FetchLike, type ScopeHost } from '@substrat-run/kernel';

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

/** One call's timing: the control plane's wall clock, and the share the provider's calls took. */
interface Timed {
  probe: ConnectionProbe;
  totalMs: number;
  providerMs: number;
}

/**
 * The probes made through the script. `record: false` is the hop probe's shadow: the provider is
 * called, and nothing is recorded against the connection.
 */
function scriptProbes(env: ConnectorScriptEnv, spec: ConnectorScriptSpec, record = true) {
  const call = async (tenantId: string | null, request: ConnectorScriptCallRequest, onUses: (uses: ConnectionUseOutcomeWire[]) => Promise<void>): Promise<Timed> => {
    const started = Date.now();
    const done = (probe: ConnectionProbe, providerMs = 0): Timed => ({ probe, totalMs: Date.now() - started, providerMs });
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
    await onUses(response.uses);
    const providerMs = response.uses.reduce((sum, u) => sum + (u.durationMs ?? 0), 0);
    if (!response.ok) return done(failure(response.error, response.refused), providerMs);
    // Phase 1 carries no connector state, so a script that writes some is not one this plane runs.
    if (response.state.length > 0) return done(failure(`the ${spec.provider} connector script wrote connector state, which a probe never does`), providerMs);
    const probe = connectionProbe.safeParse(response.result);
    return done(probe.success ? probe.data : failure(`the ${spec.provider} connector script answered a probe that does not read as one`), providerMs);
  };
  return {
    probe: async (host: ScopeHost, connection: Connection): Promise<Timed> => {
      const started = Date.now();
      try {
        // The same row the in-process probe opens: the tenant's live connection of this provider.
        const open = await host.admin.openConnection(tenantIdSchema.parse(connection.tenantId), connection.vertical, spec.provider);
        if (!open) return { probe: failure(`no live '${spec.provider}' connection for tenant ${connection.tenantId} / vertical '${connection.vertical}'`), totalMs: Date.now() - started, providerMs: 0 };
        const secret: Record<string, string> = {};
        for (const [key, value] of Object.entries(open.secret as Record<string, unknown>)) {
          if (typeof value !== 'string') return { probe: failure(`the stored credential holds a non-string value under '${key}'`), totalMs: Date.now() - started, providerMs: 0 };
          secret[key] = value;
        }
        const request: ConnectorScriptCallRequest = {
          role: 'probe',
          provider: spec.provider,
          connection: { id: open.id, tenantId: connection.tenantId, vertical: connection.vertical, provider: spec.provider, externalAccountRef: connection.externalAccountRef, expiresAt: open.expiresAt === null ? null : instant.parse(open.expiresAt), secret },
          state: [],
          config: spec.config(),
        };
        const timed = await call(connection.tenantId, request, async (uses) => {
          if (record) for (const use of uses) await host.admin.recordConnectionUse(open.id, use);
        });
        return { ...timed, totalMs: Date.now() - started };
      } catch (e) {
        return { probe: failure(`the probe could not run: ${message(e)}`), totalMs: Date.now() - started, providerMs: 0 };
      }
    },
    // No connection exists yet, so nothing is recorded, and no tenant is metered.
    probeCandidate: (secret: Record<string, string>): Promise<Timed> =>
      call(null, { role: 'probe-candidate', provider: spec.provider, secret, config: spec.config() }, async () => {}),
  };
}

/** A `fetch` that adds each call's duration to `sink.ms`. */
function timedFetch(fetch: FetchLike, sink: { ms: number }): FetchLike {
  return async (input, init) => {
    const started = Date.now();
    try {
      return await fetch(input, init);
    } finally {
      sink.ms += Date.now() - started;
    }
  };
}

async function timeLocal(run: (fetch: FetchLike) => Promise<ConnectionProbe>): Promise<Timed> {
  const sink = { ms: 0 };
  const started = Date.now();
  const probe = await run(timedFetch(globalFetch, sink));
  return { probe, totalMs: Date.now() - started, providerMs: sink.ms };
}

/**
 * The probes a registration hands over for `spec.provider`: in-process, or through its script,
 * as {@link runsAsScript} says, and both ways at once under the hop probe.
 */
export function placedProbes(env: ConnectorScriptEnv, spec: ConnectorScriptSpec): ConnectorProbes {
  const remote = runsAsScript(env, spec.provider);
  if (!listed(env.PROBE_CONNECTOR_HOP, spec.provider)) {
    if (!remote) return spec.local(globalFetch);
    const script = scriptProbes(env, spec);
    return {
      probe: async (host, connection) => (await script.probe(host, connection)).probe,
      probeCandidate: async (secret) => (await script.probeCandidate(secret)).probe,
    };
  }
  // The hop probe. The placed side answers and records; the shadow calls the provider and records
  // nothing, so a stored connection's shadow runs as a candidate probe of its opened credential.
  const placed = scriptProbes(env, spec, true);
  const shadow = scriptProbes(env, spec, false);
  const compare = async (role: 'probe' | 'probe-candidate', inProcess: () => Promise<Timed>, viaScript: () => Promise<Timed>): Promise<ConnectionProbe> => {
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
    return (remote ? script : local).probe;
  };
  return {
    probe: (host, connection) =>
      compare(
        'probe',
        () =>
          remote
            ? timeLocal(async (fetch) => {
                const open = await host.admin.openConnection(tenantIdSchema.parse(connection.tenantId), connection.vertical, spec.provider);
                if (!open) return failure(`no live '${spec.provider}' connection`);
                return spec.local(fetch).probeCandidate(open.secret as Record<string, string>);
              })
            : timeLocal((fetch) => spec.local(fetch).probe(host, connection)),
        () => (remote ? placed : shadow).probe(host, connection),
      ),
    probeCandidate: (secret) =>
      compare('probe-candidate', () => timeLocal((fetch) => spec.local(fetch).probeCandidate(secret)), () => placed.probeCandidate(secret)),
  };
}
