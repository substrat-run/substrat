import { isVerticalConnectorProvider, type PlatformActorId } from '@substrat-run/contracts';
import {
  resolveVerticalConnectorTarget,
  verticalConnectorBinder,
  verticalConnectorReadsOf,
  type VerticalConnectorDeps,
} from '@substrat-run/control-plane-api';
import type { ConnectionBinder } from '@substrat-run/kernel';
import type { CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';

/**
 * The control plane's half of a vertical-defined connector (docs/architecture/vertical-connectors.md
 * §6.3, §6.4): the transport that takes a call to the target `resolveVerticalConnectorTarget`
 * decides from this directory's and registry's reads.
 */

/**
 * The router's `ConnectorCalls` entrypoint, structurally — the router dispatches the call into
 * the target deployment under its `outbound` hosts, which a `dispatch.get(ref)` from here cannot.
 */
export interface ConnectorCallsBinding {
  call(target: unknown, request: unknown): Promise<{ status: number; body: unknown }>;
}

/** The deps every vertical-defined connector role runs on, with its reads made as `actor`. */
export function verticalConnectorDepsFor(
  env: { CONNECTOR_CALLS?: ConnectorCallsBinding },
  host: CloudflareScopeHost,
  actor: PlatformActorId,
): VerticalConnectorDeps {
  const reads = verticalConnectorReadsOf(host, actor);
  return {
    host,
    actor,
    now: () => new Date().toISOString(),
    resolve: (input) => resolveVerticalConnectorTarget(reads, input),
    call: async (target, request) => {
      if (!env.CONNECTOR_CALLS) throw new Error('this control plane has no CONNECTOR_CALLS binding');
      return env.CONNECTOR_CALLS.call(target, request);
    },
  };
}

/**
 * The `binderFor` every connection-landings read takes: a vertical-defined provider's bindings are
 * its own (vertical-connectors.md §6.1), and every other provider's binder comes from the
 * first-party registry instead. One function, so the sweep and the relay doors cannot disagree on
 * which connections are found bound.
 */
export function verticalConnectorBinderFor(
  env: { CONNECTOR_CALLS?: ConnectorCallsBinding },
  host: CloudflareScopeHost,
  actor: PlatformActorId,
): (connection: { provider: string }) => ConnectionBinder | undefined {
  return (connection) => (isVerticalConnectorProvider(connection.provider) ? verticalConnectorBinder(verticalConnectorDepsFor(env, host, actor)) : undefined);
}
