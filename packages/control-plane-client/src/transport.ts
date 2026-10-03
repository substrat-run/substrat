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
  /**
   * Defaults to the global `fetch`, looked up at CALL time rather than captured when the
   * client is built — so a caller that swaps `globalThis.fetch` afterwards (a test, an
   * instrumented runtime) is honoured, and workerd still sees the global as the receiver.
   */
  fetch?: typeof globalThis.fetch;
  /** Passed to `fetch` only when set — `'include'` carries the console's staff session cookie. */
  credentials?: RequestCredentials;
  /**
   * Extra headers sent with every request — for a caller that already holds a resolved
   * credential header map (the CLI's `Authorization: Bearer …` / `x-service-token`, plus the
   * tenant it acts for). PRECEDENCE, lowest first: these, then the transport's own
   * credential (`serviceToken` / `actor`), then the content type, then the request's own
   * `init.headers`. A client that has a credential of its own ignores any credential header
   * (`x-service-token`, `x-platform-actor`, any case) in this map, and a call that names a
   * credential replaces the client's, so exactly one credential leaves per request — two are
   * refused with a `ControlPlaneUsageError` before anything is sent; a single call can still override
   * anything else.
   */
  headers?: Record<string, string>;
  /**
   * The `content-type` sent on every request. Defaults to `'application/json'` (what every
   * existing caller has always sent, bodyless GETs included); `null` sends none, for a caller
   * whose requests set their own per call.
   */
  contentType?: string | null;
  /**
   * Called with every response that arrives — success or refusal — before it is read: the
   * hook for a header the plane stamps on any answer (the CLI's version advisory). Never
   * called for a transport failure, and a throw from it is the caller's own.
   */
  onResponse?: (res: { status: number; headers: Headers }) => void;
}

/** What a refusal carried beyond its sentence, for a caller that renders its own. */
export interface ControlPlaneErrorDetail {
  /**
   * The response body as text, exactly as it arrived. `''` is a body that was empty;
   * `undefined` is one that could not be read (the stream failed), which a caller that
   * prints a status line instead — as the CLI does — tells apart.
   */
  body?: string;
  /** The status line's reason phrase (`Bad Gateway`). */
  statusText?: string;
  /** The response headers. */
  headers?: Headers;
  /** The full URL requested. */
  url?: string;
  /** Set on a 2xx whose body was not the JSON the route promises — `body` says what it was. */
  malformed?: true;
  /** The underlying failure, for a transport error (`status` 0): the error `fetch` threw. */
  cause?: unknown;
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
    detail: ControlPlaneErrorDetail = {},
  ) {
    super(message, 'cause' in detail ? { cause: detail.cause } : undefined);
    this.name = 'ControlPlaneError';
    this.body = detail.body;
    this.statusText = detail.statusText;
    this.headers = detail.headers;
    this.url = detail.url;
    this.malformed = detail.malformed === true;
  }

  /** The refusal's raw body text; `undefined` for an error the transport did not read off a response. */
  readonly body: string | undefined;
  readonly statusText: string | undefined;
  readonly headers: Headers | undefined;
  readonly url: string | undefined;
  /** True for a 2xx answer that was not the JSON the route promises. */
  readonly malformed: boolean;
}

/**
 * The caller built a request the client refuses to send — today, one that would carry two
 * credentials. A mistake in how the client was used, raised BEFORE anything leaves, so it is
 * not a `ControlPlaneError` (no plane answered, none was found unreachable) and not a
 * `TypeError` either: `fetch` itself throws `TypeError` for a network failure, and a caller
 * that retries on transport errors must be able to tell the two apart by class.
 */
export class ControlPlaneUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControlPlaneUsageError';
  }
}

export class ControlPlaneTransport {
  private readonly baseUrl: string;
  private readonly actor: string | null;
  private readonly serviceToken?: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly credentials?: RequestCredentials;
  private readonly extraHeaders?: Record<string, string>;
  private readonly contentType: string | null;
  private readonly onResponse?: ControlPlaneTransportOptions['onResponse'];

  constructor(options: ControlPlaneTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.actor = options.actor;
    this.serviceToken = options.serviceToken;
    this.credentials = options.credentials;
    this.extraHeaders = options.headers;
    this.contentType = options.contentType === undefined ? 'application/json' : options.contentType;
    this.onResponse = options.onResponse;
    // Resolved at CALL time, and called as a function on the global: workerd throws
    // "Illegal invocation" if `fetch` is called with a `this` other than the global scope
    // (which `this.fetchImpl(...)` would otherwise set to this instance), and reading
    // `globalThis.fetch` per call — rather than binding it once here — lets a caller swap it
    // afterwards. An injected fetch is used as-is.
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /**
   * One request on the wire, exactly as `send` makes it, and nothing more: the base URL, the
   * credential and the headers are applied, and the `Response` comes back whatever its status.
   * A `fetch` rejection propagates unchanged. For a caller that owns its own reading of
   * the answer — a retry loop, a multipart upload — and wants the transport's addressing and
   * credentials without its error policy.
   */
  async request(path: string, init?: RequestInit): Promise<Response> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      ...(this.credentials ? { credentials: this.credentials } : {}),
      headers: this.headersFor(init?.headers),
    });
    this.onResponse?.({ status: res.status, headers: res.headers });
    return res;
  }

  /**
   * The headers one request goes out with, merged through the `Headers` API so that names
   * compare case-insensitively and every `HeadersInit` shape — a record, a tuple array or a
   * `Headers` instance — is read the same way. Spreading the call's headers as if they were a
   * record dropped a `Headers` instance's entries altogether, and let `Content-Type` and
   * `content-type` ride side by side. Lowest first: the `headers` option, the transport's own
   * credential, the content type, then the call's own.
   */
  private headersFor(call: HeadersInit | undefined): Record<string, string> {
    const merged = new Headers(this.extraHeaders);
    // One credential per request (#980): a service token identifies the caller as
    // the plane's service actor and is checked BEFORE the dev-actor stub, so the
    // actor header would be ignored there — and a dev-only header has no business
    // leaving a production caller at all. Without a token, the actor header IS the
    // (local, UNSAFE) credential.
    //
    // That holds against the `headers` option too: a client that has a credential of its own
    // drops BOTH credential headers from the option before applying it, so a stale entry for
    // the OTHER header cannot ride beside the one the client chose. (Setting only the chosen
    // one would leave, say, an `x-platform-actor` from the map next to the token.) A client
    // with none — the CLI, which hands over a resolved map — passes the map through as it is.
    if (this.serviceToken || this.actor !== null) {
      merged.delete(SERVICE_TOKEN_HEADER);
      merged.delete(DEV_ACTOR_HEADER);
    }
    if (this.serviceToken) merged.set(SERVICE_TOKEN_HEADER, this.serviceToken);
    else if (this.actor !== null) merged.set(DEV_ACTOR_HEADER, this.actor);
    if (this.contentType !== null) merged.set('content-type', this.contentType);
    // A call that names a credential of its own REPLACES the client's: the other credential
    // header goes with it, so the request still carries exactly one. (Merging the call's header
    // over the client's would send both whenever they differ in which header they use.)
    const callHeaders = new Headers(call);
    if (callHeaders.has(SERVICE_TOKEN_HEADER) || callHeaders.has(DEV_ACTOR_HEADER)) {
      merged.delete(SERVICE_TOKEN_HEADER);
      merged.delete(DEV_ACTOR_HEADER);
    }
    callHeaders.forEach((value, name) => merged.set(name, value));
    // Whatever way it was assembled, two credentials never leave together: a call that names
    // both, or an option map that carries both to a client with none of its own, is refused
    // here, before anything is sent, rather than left for the plane to pick between.
    if (merged.has(SERVICE_TOKEN_HEADER) && merged.has(DEV_ACTOR_HEADER)) {
      throw new ControlPlaneUsageError(
        `a request names two credentials (${SERVICE_TOKEN_HEADER} and ${DEV_ACTOR_HEADER}) — send exactly one`,
      );
    }
    return Object.fromEntries(merged.entries());
  }

  /** The full URL a path is requested at — for a message that names it. */
  urlFor(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  /**
   * One request, and the one place a failure is read: a transport error or a non-2xx answer
   * throws `ControlPlaneError`, so what comes back is always a successful `Response`. A 404
   * is handed back as-is when the caller allows it.
   */
  protected async send(path: string, init?: RequestInit, allow404 = false): Promise<Response> {
    let res: Response;
    try {
      res = await this.request(path, init);
    } catch (e) {
      // A refused request is the caller's mistake, not an unreachable plane: it never left.
      if (e instanceof ControlPlaneUsageError) throw e;
      // A transport failure (control plane down) must fail closed, not silently
      // pass — a vertical that cannot reach the authority does not get to run.
      throw new ControlPlaneError(0, `control plane unreachable: ${(e as Error).message}`, undefined, {
        cause: e,
        url: this.urlFor(path),
      });
    }
    if (res.status === 404 && allow404) return res;
    if (!res.ok) {
      // `problemDetail` is the one reading of a failed body (#971): the RFC 9457
      // `detail` first, the deprecated `error` duplicate second, both against the
      // published schema — so this works either way, and keeps working the day the
      // duplicate is deleted. The status line is the fallback only when the body
      // said nothing readable.
      const text: string | undefined = await res.text().catch(() => undefined);
      let body: unknown = null;
      try {
        body = JSON.parse(text ?? '');
      } catch {
        // Not JSON, or unreadable: `problemDetail(null)` is undefined and the status line speaks.
      }
      // A connect the provider refused carries the provider's own answer beside the
      // sentence (#605) — read off the same parse, so no caller re-reads the body for it.
      const probe =
        body !== null && typeof body === 'object' ? (body as { probe?: ConnectionProbe }).probe : undefined;
      throw new ControlPlaneError(
        res.status,
        problemDetail(body) ?? `${res.status} ${res.statusText}`,
        probe,
        { body: text, statusText: res.statusText, headers: res.headers, url: this.urlFor(path) },
      );
    }
    return res;
  }

  protected async call<T>(path: string, init?: RequestInit, allow404 = false): Promise<T> {
    const res = await this.send(path, init, allow404);
    if (res.status === 404 && allow404) return undefined as T;
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  /**
   * A JSON answer, read from its text so a 2xx that is not JSON says what it was: a
   * `ControlPlaneError` flagged `malformed`, carrying the `body` and `url` — the common
   * misconfiguration being a base URL that points at a web page rather than the API. Unlike
   * `call`, no status is special-cased: a 204 is an empty body, which is not JSON.
   */
  protected async read<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.send(path, init);
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      const url = this.urlFor(path);
      throw new ControlPlaneError(res.status, `got a non-JSON response from ${url}`, undefined, {
        body: text,
        headers: res.headers,
        url,
        malformed: true,
      });
    }
  }
}
