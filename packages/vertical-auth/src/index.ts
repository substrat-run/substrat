export type { AuthProvider, AuthSubject } from './provider.js';
export { oidcAuthProvider, type OidcConfig } from './oidc.js';
export { oidcRpAuthProvider, type OidcRpConfig } from './oidc-rp-provider.js';
export { IdentityDO, doAuthProvider, type IdentityDoEnv, type IdentityStub } from './identity-do.js';
export { resolveCookieDomain } from './cookie-domain.js';
export { FIRST_SIGN_IN_WINDOW_MS, OWNER_CLAIM_TTL_MS, type OwnerSeat } from './owner-seat.js';
export { mintOwnerClaimLink, ownerClaimPath, sha256Hex } from './owner-claim-link.js';
export {
  AUTH_CONFIG_KEY,
  AuthConfigError,
  authChoice,
  instanceAuthFor,
  parseAuthChoice,
  selectAuthProvider,
  type AuthChoice,
  type InstanceAuth,
} from './instance-auth.js';
