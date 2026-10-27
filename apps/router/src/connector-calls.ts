import { WorkerEntrypoint } from 'cloudflare:workers';
import type { ConnectorCallTransportResult } from '@substrat-run/contracts';
import { handleConnectorCall, type Env } from './worker.js';

/**
 * The connector-call entrypoint (vertical-connectors.md §6.3). Only the control plane binds it
 * (`CONNECTOR_CALLS`), so the target and its outbound hosts are the platform's. Everything it
 * decides is `handleConnectorCall`, which the router's node tests reach without the workers runtime.
 */
export class ConnectorCalls extends WorkerEntrypoint<Env> {
  call(target: unknown, request: unknown): Promise<ConnectorCallTransportResult> {
    return handleConnectorCall(this.env, target, request);
  }
}
