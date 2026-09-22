export type { AuthProvider, AuthSubject } from './provider.js';
export { oidcAuthProvider, type OidcConfig } from './oidc.js';
export { oidcRpAuthProvider, type OidcRpConfig } from './oidc-rp-provider.js';
export { IdentityDO, doAuthProvider, type IdentityDoEnv, type IdentityStub } from './identity-do.js';
export { resolveCookieDomain } from './cookie-domain.js';
export { FIRST_SIGN_IN_WINDOW_MS, OWNER_CLAIM_TTL_MS, type OwnerSeat } from './owner-seat.js';
export { invitePath, mintOwnerClaimLink, ownerClaimPath, sha256Hex } from './owner-claim-link.js';
// `mountInviteRoutes` is deliberately NOT re-exported here. It is the one module in this
// package that imports `hono` at runtime, and a barrel re-export would make every
// `import '@substrat-run/vertical-auth'` evaluate it — so a consumer that wants only an
// `AuthProvider` or the OIDC helpers would resolve a peer it never uses. It lives on the
// `@substrat-run/vertical-auth/invite-routes` subpath, beside `./provider` and `./oidc`,
// for the same reason those do.
export {
  AUTH_CONFIG_KEY,
  AuthConfigError,
  authChoice,
  authorizationServersOf,
  instanceAuthFor,
  parseAuthChoice,
  selectAuthProvider,
  type AuthChoice,
  type InstanceAuth,
} from './instance-auth.js';
// A login's places (#1670): what a vertical tells the identity pool about its own scope.
export {
  observePlace,
  placesReporter,
  reportScopeMembers,
  resetPlacesMemo,
  unbindMember,
  type PlaceReportResult,
  type PlacesReporter,
} from './places.js';
