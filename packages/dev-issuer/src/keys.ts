/**
 * The dev issuer's signing key — CHECKED IN, PUBLIC, AND DELIBERATELY SO.
 *
 * A relying party verifies an ID token against the issuer's JWKS, so the issuer needs a
 * keypair. Generating one at boot would work, but every restart would invalidate every
 * session a developer holds, and the `/dev/token` bearers a test script minted would stop
 * verifying halfway through a run. So the key is FIXED, and fixed means public: this file
 * is in the repository, and anyone can mint a token that this issuer's JWKS will validate.
 *
 * That is the correct posture for a process that binds to localhost, hands out logins by
 * clicking a name, and is never deployed. It is also the reason nothing may point a
 * PRODUCTION relying party at a dev issuer: the trust anchor is this file.
 *
 * ES256 (P-256) rather than RS256 — smaller, and `createRemoteJWKSet` accepts both.
 */

/** The `kid` every token this issuer signs carries, and the only key its JWKS publishes. */
export const DEV_KID = 'substrat-dev-issuer';

export const DEV_ALG = 'ES256';

/** The private half. Public by construction — see the file header. */
export const DEV_PRIVATE_JWK = {
  kty: 'EC',
  crv: 'P-256',
  x: 'EM7WyKnjAYcG4u-ZrQV-MnDWYl7M4AKVody95UZaPw4',
  y: 'GJFEBnTwfQmMv-q1N-vv6GNMDp_i7lVeyoOaHXEt0E0',
  d: 'ut3dmM8nwUpdo-7yygjdzUyksvJ6asXBf7KFKDJ8wus',
} as const;

/** The public half, in the shape `/jwks.json` serves it. */
export const DEV_PUBLIC_JWK = {
  kty: 'EC',
  crv: 'P-256',
  x: DEV_PRIVATE_JWK.x,
  y: DEV_PRIVATE_JWK.y,
  use: 'sig',
  alg: DEV_ALG,
  kid: DEV_KID,
} as const;
