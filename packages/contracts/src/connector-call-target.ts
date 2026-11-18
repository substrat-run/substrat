import { z } from 'zod';
import { scopeId, tenantId, verticalSlug } from './ids.js';
import { outboundHost } from './deploy.js';
import { CONNECTOR_SCRIPT_PREFIX } from './script-names.js';

/**
 * Where the router dispatches one connector call (vertical-connectors.md §6.3), as the control
 * plane hands it to the router's `ConnectorCalls` entrypoint beside the `connectorCallRequest`.
 * `hosts` is the target version's declared `outbound`, which the router passes on as the
 * dispatch's outbound policy, so the egress worker holds the connector to it.
 *
 * Its own module rather than `vertical-connector.ts`: `deploy.ts` imports that file, so reusing
 * `outboundHost` from there would make a module cycle that leaves one side undefined at load.
 */
export const connectorCallTarget = z
  .object({
    deploymentRef: z.string().min(1),
    slug: verticalSlug,
    tenantId,
    /** `null` for a connection-level call (probe, probe-candidate). */
    scopeId: scopeId.nullable(),
    hosts: z.array(outboundHost).max(32),
  })
  .strict();
export type ConnectorCallTarget = z.infer<typeof connectorCallTarget>;

/** What `ConnectorCalls.call` resolves with: the vertical's HTTP status and its parsed JSON body (null when not JSON). */
export type ConnectorCallTransportResult = { status: number; body: unknown };

/**
 * Where the router dispatches one call into a first-party connector script
 * (docs/rfc/connector-scripts.md). `hosts` is the connector's declared egress for this call, which
 * the router passes on as the dispatch's outbound policy, exactly as it does a vertical's.
 * Connection-level only in phase 1: a script call names no scope.
 */
export const connectorScriptCallTarget = z
  .object({
    script: z.string().startsWith(CONNECTOR_SCRIPT_PREFIX).max(128).regex(/^[a-z0-9-]+$/),
    /**
     * The tenant the call is metered to: the connection's on a `probe`, which the router holds the
     * connection to, and `null` on a `probe-candidate`, which is made before any connection exists.
     */
    tenantId: tenantId.nullable(),
    hosts: z.array(outboundHost).min(1).max(32),
  })
  .strict();
export type ConnectorScriptCallTarget = z.infer<typeof connectorScriptCallTarget>;
