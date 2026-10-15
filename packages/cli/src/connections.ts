import type { ConnectionScopeBindingInput } from '@substrat-run/control-plane-client';
import { planeFor, viaPlane, bodyOrStatus } from './plane.js';

export interface ConnectionCommandOptions {
  controlPlaneUrl: string;
  header: Record<string, string>;
  tenantId: string;
  connectionId: string;
}

export function bindConnectionScope(opts: ConnectionCommandOptions & { scopeId: string; input: ConnectionScopeBindingInput }) {
  return viaPlane(
    () => planeFor(opts.controlPlaneUrl, opts.header).bindConnectionScope(opts.tenantId, opts.connectionId, opts.scopeId, opts.input),
    (e) => new Error(`connection bind refused (${e.status}): ${bodyOrStatus(e)}`),
  );
}

export function listConnectionBindings(opts: ConnectionCommandOptions) {
  return viaPlane(
    () => planeFor(opts.controlPlaneUrl, opts.header).listConnectionBindings(opts.tenantId, opts.connectionId),
    (e) => new Error(`connection bindings refused (${e.status}): ${bodyOrStatus(e)}`),
  );
}
