import { problemDetail } from '@substrat-run/contracts';
import type { ConnectionProbe } from '@substrat-run/contracts';

import { DEV_ACTOR_HEADER, SERVICE_TOKEN_HEADER } from './headers.js';

/**
 * The one HTTP seam every control-plane caller shares (#971): how a request is
 * authenticated, how a failure is read, and what an empty answer is. The callers
 * differ in what they ask — `ControlPlaneClient` is the vertical's connect seam,
 * `ControlPlaneStaffClient` the console's staff surface — not in how they ask it.
 *
 * Browser-safe: nothing here reaches past `fetch` and `@substrat-run/contracts`, which is
 * why the console can import it (`@substrat-run/control-plane-client`).
 */
export interface ControlPlaneTransportOptions {
  /** Base URL of the control-plane API; a path such as `/api` is fine in a browser. */
  baseUrl: string;
  /**
   * The dev-only `x-platform-actor` header, sent only when no `serviceToken` is set. `null`
   * sends none: the console's session mode, where the staff cookie authenticates instead.
   */
  actor: string | null;
  serviceToken?: string;
  fetch?: typeof globalThis.fetch;
  /** Passed to `fetch` only when set — `'include'` carries the console's staff session cookie. */
  credentials?: RequestCredentials;
}

/** A non-2xx (or unreachable) control-plane response. `status` is 0 on a transport error. */
export class ControlPlaneError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /**
     * The provider's own answer, when the plane refused a connect because the credential
     * was rejected upstream (#605, 422). Carried so a console can show WHY — "Scrive:
     * No valid access credentials were provided" — instead of a generic save failure.
     */
    readonly probe?: ConnectionProbe,
  ) {
    super(message);
    this.name = 'ControlPlaneError';
  }
}

export class ControlPlaneTransport {
  private readonly baseUrl: string;
  private readonly actor: string | null;
  private readonly serviceToken?: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly credentials?: RequestCredentials;

  constructor(options: ControlPlaneTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.actor = options.actor;
    this.serviceToken = options.serviceToken;
    this.credentials = options.credentials;
    // Bind to globalThis: workerd throws "Illegal invocation" if `fetch` is called
    // with a `this` other than the global scope (which `this.fetchImpl(...)` would
    // otherwise set to this instance). An injected fetch is used as-is.
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * One request, and the one place a failure is read: a transport error or a non-2xx answer
   * throws `ControlPlaneError`, so what comes back is always a successful `Response`. A 404
   * is handed back as-is when the caller allows it.
   */
  protected async send(path: string, init?: RequestInit, allow404 = false): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        ...(this.credentials ? { credentials: this.credentials } : {}),
        headers: {
          // One credential per request (#980): a service token identifies the caller as
          // the plane's service actor and is checked BEFORE the dev-actor stub, so the
          // actor header would be ignored there — and a dev-only header has no business
          // leaving a production caller at all. Without a token, the actor header IS the
          // (local, UNSAFE) credential.
          ...(this.serviceToken
            ? { [SERVICE_TOKEN_HEADER]: this.serviceToken }
            : this.actor !== null
              ? { [DEV_ACTOR_HEADER]: this.actor }
              : {}),
          'content-type': 'application/json',
          ...init?.headers,
        },
      });
    } catch (e) {
      // A transport failure (control plane down) must fail closed, not silently
      // pass — a vertical that cannot reach the authority does not get to run.
      throw new ControlPlaneError(0, `control plane unreachable: ${(e as Error).message}`);
    }
    if (res.status === 404 && allow404) return res;
    if (!res.ok) {
      // `problemDetail` is the one reading of a failed body (#971): the RFC 9457
      // `detail` first, the deprecated `error` duplicate second, both against the
      // published schema — so this works either way, and keeps working the day the
      // duplicate is deleted. The status line is the fallback only when the body
      // said nothing readable.
      const body = await res.json().catch(() => null);
      throw new ControlPlaneError(
        res.status,
        problemDetail(body) ?? `${res.status} ${res.statusText}`,
      );
    }
    return res;
  }

  protected async call<T>(path: string, init?: RequestInit, allow404 = false): Promise<T> {
    const res = await this.send(path, init, allow404);
    if (res.status === 404 && allow404) return undefined as T;
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }
}
