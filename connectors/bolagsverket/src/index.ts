/**
 * `@substrat-run/connector-bolagsverket` — validates a Swedish organisation number against
 * Bolagsverket's free value-datasets API (EU high-value datasets).
 *
 * Host code, never module code: module code reaches a connector as a capability and never
 * calls `fetch`. The credential is the tenant's own, pasted and sealed in a per-tenant
 * connection; `connector.ts` is what the control plane's registration calls.
 */
export {
  BOLAGSVERKET_CONNECTION_GRANTS,
  BOLAGSVERKET_PROVIDER,
  bolagsverketCredentialSummary,
  probeBolagsverketConnection,
  probeBolagsverketSecret,
  sweepBolagsverket,
  type BolagsverketConnectorOptions,
} from './connector.js';
export { BolagsverketApi, type BolagsverketApiOptions } from './api.js';
export {
  BOLAGSVERKET_ENVIRONMENTS,
  BOLAGSVERKET_SCOPES,
  bolagsverketCredential,
  resolveEndpoints,
  type BolagsverketConfig,
  type BolagsverketCredential,
  type BolagsverketEndpoints,
  type BolagsverketEnvironment,
} from './config.js';
export { BolagsverketError, type BolagsverketErrorCode } from './errors.js';
export {
  ORGANISATION_STATUSES,
  organisationValidation,
  type OrganisationStatus,
  type OrganisationValidation,
} from './organisation.js';
export { parseOrgnr, type Orgnr, type OrgnrParse, type OrgnrRefusal } from './orgnr.js';
export { RATE_LIMIT_REQUESTS, RATE_LIMIT_WINDOW_MS } from './throttle.js';
