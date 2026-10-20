/**
 * The `AuthProvider` contract — the ONLY thing a vertical's app depends on for identity.
 *
 * The application codes to this interface: OIDC bearer verification, the browser
 * relying-party flow, or a test mock all satisfy it. Swapping the implementation never touches the app.
 *
 *   - `handle` — the credential/session endpoints (`/api/auth/*`): sign-up, login, logout,
 *     callbacks. The worker forwards the raw request; the provider owns what's behind it.
 *   - `resolve` — turn the current request into a verified subject, or null. `sub` is the
 *     provider's stable subject id; mapping it to a Substrat `PrincipalId` is a SEPARATE,
 *     per-scope concern (the identity directory), not the provider's job.
 */
export interface AuthSubject {
  /** The provider's stable subject id — an OIDC `sub` */
  sub: string;
  email: string | null;
  name: string | null;
  /**
   * Whether the provider says `email` has been verified — **three states, not two**.
   * `true` and `false` are the provider asserting something; `undefined` is it saying
   * nothing, which is what an OIDC issuer that never emits `email_verified` looks like,
   * and what a session minted before this field existed looks like for the rest of its
   * life. Optional so a provider that cannot answer stays honest rather than guessing.
   *
   * Nothing resolves authorization from it yet. It is carried because an address becomes
   * an identifier in invite flows and on the staff roster, and a gate there cannot be
   * written against a claim nobody transported (#1359) — the caller that eventually
   * gates on it decides what `undefined` means.
   */
  emailVerified?: boolean;
  /**
   * When the credential that proved this subject stops being valid (ISO 8601): a session's
   * or a bearer's `exp`. Absent when the provider cannot say. Something held open past the
   * request on this subject's strength — a live-read socket (#938) — ends at it.
   */
  expiresAt?: string;
  /**
   * Present only when the credential is a DELEGATED token (#1824): another app, the actor,
   * is acting for this user, and may do so only within `scope` — permission keys of this
   * app, a ceiling over what the user may do rather than a grant. Absent means the user is
   * acting directly. A provider admits a delegated token only when the host opted in
   * (`OidcConfig.delegation`), so a caller that never reads this field never sees one.
   */
  delegation?: { actor: string; scope: string[] };
}

/** Per-request facts a caller may hand `resolve`. Additive: a provider ignores what it does not use. */
export interface ResolveOptions {
  /**
   * This request is being served by an MCP endpoint that holds a delegated token to its scope,
   * answering as `resource` (#1824) — `mcpChannelOf(c)` from `@substrat-run/vertical-host`,
   * which only that endpoint's own handler can see. A delegated bearer is admitted only when
   * this is passed, and only for exactly this resource. Absent or `null`, none is.
   *
   * A caller that serves its own MCP surface and passes a value here takes on the ceiling: the
   * subject's `delegation.scope` is then that caller's to enforce.
   */
  delegated?: { readonly resource: string } | null;
}

export interface AuthProvider {
  handle(request: Request): Promise<Response>;
  /**
   * `url` is the request's own URL, when the caller has it. Optional and additive: a
   * provider that needs the origin (an OIDC bearer on a shared issuer holds an MCP token
   * to this app's own resource, #1683) falls back to the `Host` header without it.
   */
  resolve(headers: Headers, url?: string, options?: ResolveOptions): Promise<AuthSubject | null>;
}
