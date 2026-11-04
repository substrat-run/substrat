import { z } from 'zod';

/**
 * Bolagsverket's two environments for the value-datasets API.
 *
 * The URLs are the ones community client libraries use; they are to be checked against
 * Bolagsverket's own documentation once credentials arrive, which is what the live suite
 * is for. Production is the default and the acceptance environment is chosen explicitly,
 * as with every other connector: a default that is right for a developer and wrong for
 * a deployment is the bug class this avoids (#610, #990).
 */
export const BOLAGSVERKET_ENVIRONMENTS = {
  prod: {
    tokenUrl: 'https://portal.api.bolagsverket.se/oauth2/token',
    apiBase: 'https://gw.api.bolagsverket.se/vardefulla-datamangder/v1',
  },
  test: {
    tokenUrl: 'https://portal-accept2.api.bolagsverket.se/oauth2/token',
    apiBase: 'https://gw-accept2.api.bolagsverket.se/vardefulla-datamangder/v1',
  },
} as const;

export type BolagsverketEnvironment = keyof typeof BOLAGSVERKET_ENVIRONMENTS;

/** The scope every lookup needs. */
export const BOLAGSVERKET_READ_SCOPE = 'vardefulla-datamangder:read';

/** Both scopes the client is issued: `read` for lookups, `ping` for the health call. */
export const BOLAGSVERKET_SCOPES = `${BOLAGSVERKET_READ_SCOPE} vardefulla-datamangder:ping`;

/**
 * The OAuth2 client Bolagsverket issues per environment. A test pair does not work in
 * production and the other way round. The credential carries no environment field: the
 * environment is the deployment's (`BOLAGSVERKET_ENV` in the control plane, `environment`
 * in `BolagsverketConfig`), so a pasted pair must be one issued for that environment.
 */
export const bolagsverketCredential = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
});
export type BolagsverketCredential = z.infer<typeof bolagsverketCredential>;

export interface BolagsverketConfig {
  /** Default `prod`. */
  environment?: BolagsverketEnvironment;
  /** Overrides the environment's token URL (a proxy, a recording). */
  tokenUrl?: string;
  /** Overrides the environment's API base. */
  apiBase?: string;
}

export interface BolagsverketEndpoints {
  environment: BolagsverketEnvironment;
  tokenUrl: string;
  apiBase: string;
}

export function resolveEndpoints(config: BolagsverketConfig = {}): BolagsverketEndpoints {
  const environment = config.environment ?? 'prod';
  const defaults = BOLAGSVERKET_ENVIRONMENTS[environment];
  return {
    environment,
    tokenUrl: config.tokenUrl ?? defaults.tokenUrl,
    apiBase: (config.apiBase ?? defaults.apiBase).replace(/\/+$/, ''),
  };
}
