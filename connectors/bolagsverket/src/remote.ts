import {
  CONNECTOR_CALL_MAX_USES,
  CONNECTOR_PROBE_PATH,
  connectorScriptCallRequest,
  type ConnectionProbe,
  type ConnectionUseOutcomeWire,
  type ConnectorCallResponse,
} from '@substrat-run/contracts';
import { settleConnectionUse, type FetchLike } from '@substrat-run/kernel';
import { BOLAGSVERKET_ENVIRONMENTS, resolveEndpoints, type BolagsverketConfig } from './config.js';
import { BOLAGSVERKET_PROVIDER, probeBolagsverketSecret } from './connector.js';

/**
 * Bolagsverket as its own deployed script (docs/rfc/connector-scripts.md, phase 1).
 *
 * The control plane calls the script through the router, which dispatches it with an outbound
 * policy naming {@link bolagsverketEgressHosts}, so the egress worker holds every provider call to
 * them. Everything the script needs arrives in the call: the credential (`secret`, or the opened
 * `connection.secret`) and the deployment's configuration (`config`). It holds no binding, no
 * secret and nothing between calls: a fresh client per call, so no token outlives the request it
 * was minted for.
 *
 * Phase 1 serves the connection-level roles, `probe-candidate` and `probe`, which are all the
 * platform asks of Bolagsverket today: its sweep is a no-op and it has no dispatch.
 */

/** The configuration a call carries, from the control plane's own options. */
export function bolagsverketCallConfig(config: BolagsverketConfig): Record<string, string> {
  return {
    environment: config.environment ?? 'prod',
    ...(config.tokenUrl ? { tokenUrl: config.tokenUrl } : {}),
    ...(config.apiBase ? { apiBase: config.apiBase } : {}),
  };
}

/** The options a call's configuration names. An unknown key or environment is refused, never defaulted. */
export function bolagsverketConfigOf(config: Record<string, string> | undefined): BolagsverketConfig {
  const { environment, tokenUrl, apiBase, ...rest } = config ?? {};
  const unknown = Object.keys(rest);
  if (unknown.length > 0) throw new Error(`unknown Bolagsverket configuration: ${unknown.join(', ')}`);
  if (environment !== undefined && !Object.hasOwn(BOLAGSVERKET_ENVIRONMENTS, environment)) {
    throw new Error(`unknown Bolagsverket environment '${environment}'`);
  }
  return {
    ...(environment ? { environment: environment as BolagsverketConfig['environment'] } : {}),
    ...(tokenUrl ? { tokenUrl } : {}),
    ...(apiBase ? { apiBase } : {}),
  };
}

/** The hosts a call under `config` reaches: the token host and the API host, nothing else. */
export function bolagsverketEgressHosts(config: BolagsverketConfig): string[] {
  const { tokenUrl, apiBase } = resolveEndpoints(config);
  return [...new Set([new URL(tokenUrl).hostname, new URL(apiBase).hostname])];
}

const ERROR_MAX = 600;

/** What the script answers: the contract's response, or a refusal of the call itself. */
export type ScriptAnswer = { status: 200; body: ConnectorCallResponse } | { status: 400 | 404 | 405; body: { error: string } };

/**
 * Serve one call. A call the contract does not admit (malformed, another provider, a role this
 * script does not serve) is a 400 the control plane reports as the platform's failure, never as
 * the tenant's credential being refused. A probe that ran answers 200, whatever it found.
 */
export async function serveBolagsverketCall(path: string, method: string, body: unknown, fetch: FetchLike): Promise<ScriptAnswer> {
  if (path !== CONNECTOR_PROBE_PATH) return { status: 404, body: { error: `this connector script serves ${CONNECTOR_PROBE_PATH} only` } };
  if (method !== 'POST') return { status: 405, body: { error: 'a connector call is a POST' } };
  const parsed = connectorScriptCallRequest.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // Where, never the values: a call carries a credential.
    return { status: 400, body: { error: `not a connector call: ${issue?.path.join('.') || '(root)'} ${issue?.message ?? ''}`.trim() } };
  }
  const req = parsed.data;
  if (req.provider !== BOLAGSVERKET_PROVIDER) return { status: 400, body: { error: `this script serves ${BOLAGSVERKET_PROVIDER}, not ${req.provider}` } };
  if (req.role !== 'probe' && req.role !== 'probe-candidate') {
    return { status: 400, body: { error: `${req.role} is not served by this connector script; it serves probe and probe-candidate` } };
  }
  let config: BolagsverketConfig;
  try {
    config = bolagsverketConfigOf(req.config);
  } catch (e) {
    return { status: 400, body: { error: (e instanceof Error ? e.message : String(e)).slice(0, ERROR_MAX) } };
  }

  const uses: ConnectionUseOutcomeWire[] = [];
  const recorded: FetchLike = async (input, init) => {
    const started = Date.now();
    const record = (settled: Parameters<typeof settleConnectionUse>[2]) => {
      const use = settleConnectionUse(BOLAGSVERKET_PROVIDER, Math.max(0, Date.now() - started), settled);
      if (uses.length < CONNECTOR_CALL_MAX_USES) uses.push(use.ok ? use : { ...use, error: use.error.slice(0, ERROR_MAX) });
    };
    try {
      const response = await fetch(input, init);
      record({ response });
      return response;
    } catch (error) {
      record({ error });
      throw error;
    }
  };
  const secret = req.role === 'probe' ? req.connection.secret : req.secret;
  const probe: ConnectionProbe = await probeBolagsverketSecret(secret, { ...config, fetch: recorded });
  // A probe changes no state, so it writes none.
  return { status: 200, body: { ok: true, result: probe, state: [], uses } };
}
