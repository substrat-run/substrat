/**
 * `GET /auth/whoami` — the signed-in user + the tenants they can build for
 * (builder-plane.md §5). `substrat login` calls it to store a default tenant (and to
 * prompt when a user belongs to several); a bare `whoami` command prints it.
 */
import type { Whoami } from '@substrat-run/control-plane-client';
import { bodyOrStatus, planeFor, viaPlane } from './plane.js';

export type { Whoami };

export async function fetchWhoami(controlPlaneUrl: string, header: Record<string, string>): Promise<Whoami> {
  return viaPlane(
    () => planeFor(controlPlaneUrl, header).whoami(),
    (e) => new Error(`whoami failed (${e.status}): ${bodyOrStatus(e).slice(0, 200)}`),
  );
}
