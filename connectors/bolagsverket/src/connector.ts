import { tenantId as tenantIdSchema, type ConnectionCredential, type ConnectionProbe } from '@substrat-run/contracts';
import { deadlineFetch, settleConnectionUse, type FetchLike, type ScopeHost } from '@substrat-run/kernel';
import { BolagsverketApi } from './api.js';
import { BOLAGSVERKET_READ_SCOPE, bolagsverketCredential, type BolagsverketConfig, type BolagsverketCredential } from './config.js';
import { BolagsverketError } from './errors.js';
import type { Fetch } from './token.js';

/**
 * The platform half: what the control plane's registration calls (#2855).
 *
 * The credential is the tenant's own: a client id and secret Bolagsverket issued to them,
 * pasted into the dashboard's door and sealed in a per-tenant connection. The provider's
 * 60-a-minute limit is per client, so each tenant's traffic is metered on its own pair.
 */

export const BOLAGSVERKET_PROVIDER = 'bolagsverket';

/**
 * The standing grants a connection needs: none yet. A grant is for the return path, the
 * operation a result is landed through, and v1 lands nothing: there is no dispatch.
 */
export const BOLAGSVERKET_CONNECTION_GRANTS = [] as const;

export interface BolagsverketConnectorOptions extends BolagsverketConfig {
  fetch: FetchLike;
  timeoutMs?: number;
}

/** Probe a pasted credential before it is stored. Touches no connection and records no health. */
export async function probeBolagsverketSecret(
  secret: Record<string, string>,
  options: BolagsverketConnectorOptions,
): Promise<ConnectionProbe> {
  const parsed = bolagsverketCredential.safeParse(secret);
  if (!parsed.success) {
    return {
      ok: false,
      // Incomplete is a refusal: the provider would turn it away, and a round trip to hear
      // so tells nobody anything.
      refused: true,
      accountRef: null,
      accountLabel: null,
      facts: [],
      error: `incomplete Bolagsverket credential: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    };
  }
  return probeWith(parsed.data, deadlineFetch(options.fetch, options.timeoutMs ?? 15_000), options);
}

/** Probe the credential a live connection holds. Verifying is a use, so health is recorded. */
export async function probeBolagsverketConnection(
  host: ScopeHost,
  connection: { tenantId: string; vertical: string },
  options: BolagsverketConnectorOptions,
): Promise<ConnectionProbe> {
  const open = await openBolagsverket(host, connection);
  const bounded = deadlineFetch(options.fetch, options.timeoutMs ?? 15_000);
  const recorded: Fetch = async (input, init) => {
    const started = Date.now();
    try {
      const res = await bounded(input, init);
      await host.admin.recordConnectionUse(open.id, settleConnectionUse(BOLAGSVERKET_PROVIDER, Date.now() - started, { response: res }));
      return res;
    } catch (err) {
      await host.admin.recordConnectionUse(open.id, settleConnectionUse(BOLAGSVERKET_PROVIDER, Date.now() - started, { error: err }));
      throw err;
    }
  };
  return probeWith(bolagsverketCredential.parse(open.secret), recorded, options);
}

/**
 * Token plus ping, with no 429 retry: a probe answers a person at a form, and a rate limit
 * says nothing about the credential. The token carries no account, so the probe names the
 * environment and the granted scopes, and `accountRef` stays `null`.
 */
async function probeWith(
  credential: BolagsverketCredential,
  fetch: Fetch,
  options: BolagsverketConnectorOptions,
): Promise<ConnectionProbe> {
  const api = new BolagsverketApi(credential, fetch, { ...options, maxRateLimitRetries: 0 });
  try {
    const { environment, scopes } = await api.ping();
    const facts = [
      { label: 'Environment', value: environment },
      { label: 'Scopes', value: scopes.length > 0 ? scopes.join(' ') : '—' },
    ];
    // A ping-only client tests green on the ping and then fails every lookup, so a client
    // without the read scope is not a working connection.
    if (!scopes.includes(BOLAGSVERKET_READ_SCOPE)) {
      return {
        ok: false,
        refused: true,
        accountRef: null,
        accountLabel: null,
        facts: [...facts, { label: 'Lookups', value: `not granted: the client lacks ${BOLAGSVERKET_READ_SCOPE}` }],
        error: `the Bolagsverket client was not granted ${BOLAGSVERKET_READ_SCOPE}, so it cannot look organisations up`,
      };
    }
    return { ok: true, refused: false, accountRef: null, accountLabel: null, facts, error: null };
  } catch (err) {
    return {
      ok: false,
      refused: err instanceof BolagsverketError && err.refused,
      accountRef: null,
      accountLabel: null,
      facts: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** The stored credential, reduced: the client id names the integration, the secret stays masked. */
export async function bolagsverketCredentialSummary(
  host: ScopeHost,
  connection: { tenantId: string; vertical: string },
): Promise<ConnectionCredential> {
  const secret = bolagsverketCredential.parse((await openBolagsverket(host, connection)).secret);
  return {
    fields: [
      { key: 'clientId', label: 'Client ID', value: secret.clientId, masked: false },
      { key: 'clientSecret', label: 'Client secret', value: secret.clientSecret.length < 8 ? '••••••••' : `••••••••${secret.clientSecret.slice(-4)}`, masked: true },
    ],
  };
}

/**
 * The poll floor every registration has. Nothing is bound to a Bolagsverket connection in
 * v1, so there is nothing to re-read and the provider is not called.
 */
export async function sweepBolagsverket(): Promise<{ found: number; failed: never[] }> {
  return { found: 0, failed: [] };
}

async function openBolagsverket(host: ScopeHost, connection: { tenantId: string; vertical: string }) {
  const open = await host.admin.openConnection(tenantIdSchema.parse(connection.tenantId), connection.vertical, BOLAGSVERKET_PROVIDER);
  if (!open) {
    throw new Error(`no live 'bolagsverket' connection for tenant ${connection.tenantId} / vertical '${connection.vertical}'`);
  }
  return open;
}
