/**
 * The scopes a MACHINE client — one holding only the `client_credentials` grant (#2267) —
 * may be given.
 *
 * `oauthProvider` accepts a `client_credentials` scope only when it is one of the provider's
 * own scopes and is not user-delegated (`openid`, `profile`, `email`, `offline_access`). So a
 * scope has to exist before any machine client can hold one, and the vocabulary is ours.
 *
 * There is one, because nothing downstream reads a finer one yet: a vertical judges a machine
 * caller by the role of the principal it maps to, not by a scope on the token.
 *
 * It is registered with the provider (`auth.ts`) but kept OUT of what a self-registered
 * client is handed by default (`clientRegistrationDefaultScopes`), so no relying party
 * acquires it by registering.
 */
export const MACHINE_SCOPE = 'machine';
export const MACHINE_SCOPES: readonly string[] = [MACHINE_SCOPE];
