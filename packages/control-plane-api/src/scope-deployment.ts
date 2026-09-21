import { runningVersionOf, type ServingPointer } from '@substrat-run/kernel';
import type { VerticalClient } from './vertical-client.js';

/**
 * Which rung of the serving-ref → bound-version → slug ladder reached a scope (#1653).
 *
 * Both ladders that pick a scope's deployment — the control-plane API's `verticalForScope`
 * and the control plane's sweep resolver — say which rung chose the client, so that what
 * a reconcile records is a fact about the client it used rather than a separate read.
 */
export type ScopeDeploymentVia = 'serving-script' | 'bound-version' | 'slug';

/** A scope's deployment, and the rung that chose it. */
export interface ScopeDeployment {
  client: VerticalClient;
  via: ScopeDeploymentVia;
}

/**
 * The version the deployment chosen for `scope` runs — the one a provision receipt may
 * name after a reconcile through it (#1653).
 *
 * - `serving-script`: what the vertical's serving script serves (`runningVersionOf`), or
 *   the bound version when the pointer names another script or could not be read.
 * - `bound-version`: the bound version — that deployment IS it. This is where a serving
 *   ref that does not resolve falls to, and why the answer has to come from here: the
 *   hook that ran is the bound version's, and a receipt naming the served one would mark
 *   the scope repaired while the served version's hook never ran.
 * - `slug`: the bound version. A static binding or a slug's deployment runs whatever it
 *   runs, and the platform cannot name it; this is the answer every receipt gave before
 *   #1653, kept so a scope reached only this way is not asked again on every pass.
 */
export function versionReachedAt(
  via: ScopeDeploymentVia,
  scope: { verticalVersionId: string | null; servingRef?: string | null },
  serving: ServingPointer | null | undefined,
): string | null {
  return via === 'serving-script' ? runningVersionOf(scope, serving) : scope.verticalVersionId;
}
