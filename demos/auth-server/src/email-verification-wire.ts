/**
 * The one name the sign-in screen and the issuer share about `REQUIRE_EMAIL_VERIFICATION`.
 * Dependency-free on purpose, like the other `*-wire.ts` files: the admin app imports it, and
 * must not compile `auth.ts` to do so.
 */

/**
 * The pending authorize request, carried on a password sign-in that must NOT resume it: a
 * client requiring an SMS second factor (`passwordSecondFactor`) signs in with the password
 * first and resumes only after the code (`/phone/verify`), so the SPA cannot send `oauth_query`
 * there — the plugin would resume on the password alone. It sends the request under this name
 * instead, which only `verificationReturnsToClient` (`auth.ts`) reads, and only to address the link a
 * refused unverified sign-in mails. Better Auth's own schema strips it from the handler's body.
 */
export const OAUTH_QUERY_AFTER_VERIFICATION = 'oauth_query_after_verification';
