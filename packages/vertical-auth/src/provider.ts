/**
 * The `AuthProvider` contract — the ONLY thing a vertical's app depends on for identity.
 *
 * The application codes to this interface and does not care WHICH auth is behind it: Better
 * Auth running in a per-tenant Durable Object (`identity-do.ts`), an OIDC issuer (`oidc.ts`),
 * or a test mock all satisfy it. Swapping the implementation never touches the app.
 *
 *   - `handle` — the credential/session endpoints (`/api/auth/*`): sign-up, login, logout,
 *     callbacks. The worker forwards the raw request; the provider owns what's behind it.
 *   - `resolve` — turn the current request into a verified subject, or null. `sub` is the
 *     provider's stable subject id; mapping it to a Substrat `PrincipalId` is a SEPARATE,
 *     per-scope concern (the identity directory), not the provider's job.
 */
export interface AuthSubject {
  /** The provider's stable subject id — a Better Auth user id, an OIDC `sub`, … */
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
}

export interface AuthProvider {
  handle(request: Request): Promise<Response>;
  resolve(headers: Headers): Promise<AuthSubject | null>;
}
