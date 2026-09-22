/**
 * The delivered-config key that tells a vertical its issuer is SHARED with other clients
 * (#1683): `"true"` when the app signs in at one of its team's auth-servers, `""` (or
 * absent) otherwise. The dashboard writes it; `@substrat-run/vertical-auth` reads it.
 *
 * A team auth-server is one issuer with one JWKS for every client the team has, plus any
 * that registered themselves dynamically. So a bearer that verifies there says who signed
 * it, not whom it is for, and a vertical on such an issuer must accept only its OWN
 * tokens. An issuer an operator configured by hand is theirs, and its knob is the
 * delivered `audience`, so the vertical leaves those exactly as they were.
 *
 * A key of its own rather than a field inside `substrat:auth`: delivery is an upsert per
 * key, so the dashboard can converge an existing install on this one fact without
 * re-delivering, and therefore without reading back, the client secret stored beside it.
 */
export const SHARED_ISSUER_CONFIG_KEY = 'substrat:auth:shared-issuer';
