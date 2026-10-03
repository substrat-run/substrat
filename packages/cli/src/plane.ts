/**
 * The CLI's one way to reach the control plane (#971): `ControlPlaneBuilderClient`, built from
 * the `{ controlPlaneUrl, header }` pair every command already resolves (`config.ts`), plus the
 * translation back into what a command prints.
 *
 * The client owns the request — the URL, the verb, the body, the credential map — and the
 * CLI keeps owning the words. A refusal arrives as a `ControlPlaneError` carrying the raw body
 * and status, which each command renders with the reader it always used (`problem.ts`), so the
 * message a builder sees does not depend on which layer made the call.
 */
import { ControlPlaneBuilderClient, ControlPlaneError, walkPages } from '@substrat-run/control-plane-client';
import type { Page } from '@substrat-run/contracts';
import { parseJsonBody } from './http.js';
import { readRefused } from './problem.js';
import { warnIfStale } from './version.js';

export interface PlaneOptions {
  /**
   * Nudge the builder when the plane says this CLI is stale (`warnIfStale`), off every
   * response. Only `push`, `promote` and `preview` ever did; the rest stay silent.
   */
  advisory?: boolean;
  /**
   * The `content-type` sent on EVERY request. Absent: none on a read (a bare `GET` has never
   * carried one) and JSON on a write, which the client sets itself. `hostnames` and `preview`
   * always sent JSON, reads included, and say so.
   */
  contentType?: string;
}

/** A client over the credential map the command resolved. */
export function planeFor(
  controlPlaneUrl: string,
  header: Record<string, string>,
  opts: PlaneOptions = {},
): ControlPlaneBuilderClient {
  return new ControlPlaneBuilderClient({
    baseUrl: controlPlaneUrl,
    actor: null,
    headers: header,
    contentType: opts.contentType ?? null,
    ...(opts.advisory ? { onResponse: (res) => warnIfStale(res.headers) } : {}),
  });
}

/**
 * Run one client call and put its failure the way the CLI always has:
 *
 * - a transport failure (`status` 0) rethrows the very error `fetch` threw, not the client's
 *   wrapper — `fetch failed` is the sentence a builder has always been shown;
 * - a 2xx that was not JSON is read through `parseJsonBody`, which names the likely fix
 *   (the control-plane URL points at a web page, #387);
 * - a refusal goes to `refused`, which is the command's own message.
 */
export async function viaPlane<T>(call: () => Promise<T>, refused: (e: ControlPlaneError) => Error): Promise<T> {
  try {
    return await call();
  } catch (e) {
    if (!(e instanceof ControlPlaneError)) throw e;
    if (e.status === 0) throw e.cause ?? e;
    if (e.malformed) {
      parseJsonBody(e.body ?? '', e.url ?? '');
      throw e; // a body that parses cannot be malformed; unreachable, and loud if it is not
    }
    throw refused(e);
  }
}

/** What `await res.text().catch(() => res.statusText)` was: the body, else the status phrase. */
export const bodyOrStatus = (e: ControlPlaneError): string => e.body ?? e.statusText ?? '';

/** A refusal's body parsed, or `null` — what `await res.json().catch(() => null)` was. */
export function refusalBody(e: ControlPlaneError): unknown {
  try {
    return JSON.parse(e.body ?? '');
  } catch {
    return null;
  }
}

/**
 * Read a paged list to the END (the CLI's reads are complete-list: the max semver, installs
 * joined to hostnames), refusing the way every control-plane read does.
 */
export function walkAll<T>(fetchPage: (page: { limit: number; cursor: string | null }) => Promise<Page<T>>): Promise<T[]> {
  return viaPlane(() => walkPages(fetchPage), readRefused);
}
