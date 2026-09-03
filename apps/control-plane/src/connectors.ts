import type { ConnectorHandler, ConnectorSweeper, FetchLike, ScopeHost } from '@substrat-run/kernel';
import type { ConnectionInspector } from '@substrat-run/control-plane-api';
import {
  SCRIVE_CALLBACK_ROUTE,
  SCRIVE_CONNECTION_GRANTS,
  handleScriveCallback,
  probeScriveConnection,
  probeScriveSecret,
  scriveCallbackPath,
  scriveConnectionActivity,
  scriveConnector,
  scriveCredentialSummary,
  sweepScriveReconciliations,
} from '@substrat-run/connector-scrive';
import {
  FORTNOX_CONNECTION_GRANTS,
  fortnoxConnectionActivity,
  fortnoxCredentialSummary,
  probeFortnoxConnection,
  probeFortnoxSecret,
  sweepFortnoxLedger,
} from '@substrat-run/connector-fortnox';

/**
 * The env slice the connectors read — declared HERE rather than in `worker.ts`, so a
 * second connector's configuration arrives with the connector instead of in a second
 * file. `Env` extends this, which is what makes one entry below the whole edit.
 */
export interface ConnectorEnv {
  /**
   * Scrive API base for the platform-run connector pass (#574/#96) — the sweep, the
   * webhook ingress and the inspection reads (#605) all go through it.
   *
   * REQUIRED at use, with no default (#990). The connector used to fall back to the
   * TESTBED, which is right for a developer and wrong for a deployment: a production
   * credential sent to the testbed comes back 401, indistinguishable from a mistyped
   * key (#610). Both environments set it explicitly in `wrangler.jsonc` — production
   * `https://scrive.com` (the API lives under /api/v2 on the main host;
   * `api.scrive.com` does not resolve), TEST the testbed. Unset now throws at the
   * point of use, naming the var.
   */
  SCRIVE_BASE_URL?: string;
  /**
   * The control plane's own public origin — the base the webhook capability URL is
   * minted under. Absent ⇒ dispatch is poll-only, which is complete, just slower.
   */
  PLATFORM_CP_URL?: string;
  /**
   * Fortnox host overrides, for a test deployment pointed at a stub. Unset means the
   * REAL hosts (`api.fortnox.se`, `apps.fortnox.se`) — safe as a default where
   * Scrive's was not (#990), because Fortnox has no separate testbed origin to be
   * wrongly defaulted to: sandbox companies live on the production hosts.
   */
  FORTNOX_API_BASE?: string;
  FORTNOX_OAUTH_BASE?: string;
}

/** One uniform answer for every callback rejection; the WHY stays server-side. */
export type ConnectorCallbackOutcome =
  | { accepted: false; reason: string }
  | { accepted: true; log: string };

/**
 * Everything the control plane needs to operate ONE connector — the four roles the same
 * package plays, gathered in one value (#990).
 *
 * Before this, wiring a connector was six hand edits scattered through `worker.ts`
 * (`connectionInspectorsFor`, the drain handler, the sweeper, `connectorGrants`, the
 * callback route, and the relay's connect-time gate reaching back into the first). Five
 * of the six are a silent no-op when forgotten — an unwired sweeper simply never polls —
 * so the failure mode of a second connector was a half-connected one. Now the six sites
 * iterate `CONNECTORS`, and a connector is present or absent as a whole.
 *
 * The dashboard's `PROVIDERS` catalog (`apps/dashboard/src/integrations.ts`) is the
 * deliberate exception: it is a different worker with a different job — the credential
 * FORM a human fills in — and `pnpm lint:connector-grants` is what holds the two
 * declarations to each other.
 */
export interface ConnectorRegistration {
  /** The provider slug — what connection rows, dispatch kinds and grants are keyed by. */
  readonly provider: string;
  /**
   * The standing grants a connection of this provider is healed toward (#726 gap 2).
   * Read from the connector's own exported constant, never re-listed here: a second
   * copy is how the dashboard catalog came to disagree with the connector (#716).
   */
  readonly grants: readonly string[];
  /** #605 — what this connector can ANSWER about a connection. */
  inspector(env: ConnectorEnv): ConnectionInspector;
  /**
   * #574 phase 3 — the outbound half. The SAME closure a self-host registers
   * in-process; only the host running it changes.
   *
   * OPTIONAL, because a poll-only connector is a complete connector: Fortnox has no
   * dispatch by design (nothing inside a scope initiates a bookkeeping read — the
   * books change at the provider, and the sweep finds out by looking). Absent means
   * no `connector:<provider>` intent kind is drainable, which is right: an intent of
   * that kind could only ever have been enqueued by mistake.
   */
  dispatch?(env: ConnectorEnv): ConnectorHandler;
  /** The poll floor (#574): re-read the provider's truth and write it back. */
  sweep(env: ConnectorEnv): ConnectorSweeper;
  /**
   * The webhook ingress, for a provider that calls back (#96). Absent is a complete
   * connector — push collapses the sweep's latency, it never replaces it.
   *
   * `route` is a Hono `:param` pattern; whatever it captures is handed to `handle` as
   * the ref. Unauthenticated by design where the provider signs nothing: the token
   * minted into the URL is the whole authentication, and the handler is what checks it.
   */
  readonly callback?: {
    readonly route: string;
    handle(
      env: ConnectorEnv,
      host: ScopeHost,
      ref: Record<string, string | undefined>,
    ): Promise<ConnectorCallbackOutcome>;
  };
}

/**
 * A var a connector cannot work without, read at the point of use.
 *
 * Deliberately a throw rather than a default: the whole class of bug this closes is a
 * default that is right for a developer and wrong for a deployment (#610, #990). A
 * throw here fails THAT connector's operation loudly — the drain settles the intent
 * pending, the sweep lands the error in `report.errors`, the inspection route 500s —
 * while every other part of the control plane keeps working.
 */
function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is not set — the connector has no provider base to call`);
  return value;
}

const fetchImpl = () => globalThis.fetch as unknown as FetchLike;

const SCRIVE: ConnectorRegistration = {
  provider: 'scrive',
  grants: SCRIVE_CONNECTION_GRANTS,
  inspector: (env) => ({
    probe: async (h, row) =>
      probeScriveConnection(h, row, {
        fetch: fetchImpl(),
        baseUrl: required(env.SCRIVE_BASE_URL, 'SCRIVE_BASE_URL'),
      }),
    activity: async (h, row, opts) =>
      scriveConnectionActivity(h, row, {
        fetch: fetchImpl(),
        baseUrl: required(env.SCRIVE_BASE_URL, 'SCRIVE_BASE_URL'),
        live: opts.live,
        source: opts.source,
      }),
    credential: (h, row) => scriveCredentialSummary(h, row),
    probeCandidate: async (secret) =>
      probeScriveSecret(secret, {
        fetch: fetchImpl(),
        baseUrl: required(env.SCRIVE_BASE_URL, 'SCRIVE_BASE_URL'),
      }),
  }),
  // Built per delivery, not at wiring time: the drain's whole handler map is constructed
  // up front, so a `required` that fired there would stop EVERY intent draining over one
  // connector's missing var. Inside the closure it fails only this dispatch, which then
  // settles pending and retries — recoverable by setting the var.
  dispatch: (env) => async (ctx, event) =>
    scriveConnector({
      baseUrl: required(env.SCRIVE_BASE_URL, 'SCRIVE_BASE_URL'),
      // The callback URL terminates on THIS worker's phase-2 ingress — minted only when
      // the deployment knows its own public origin; without it the dispatch is poll-only.
      ...(env.PLATFORM_CP_URL
        ? {
            callbackUrl: (ref) =>
              `${env.PLATFORM_CP_URL!.replace(/\/+$/, '')}${scriveCallbackPath(ref)}`,
          }
        : {}),
    })(ctx, event),
  sweep: (env) => async (h, id, o) =>
    sweepScriveReconciliations(h, id, {
      ...o,
      baseUrl: required(env.SCRIVE_BASE_URL, 'SCRIVE_BASE_URL'),
    }),
  callback: {
    route: SCRIVE_CALLBACK_ROUTE,
    handle: async (env, host, ref) => {
      const outcome = await handleScriveCallback(
        host,
        {
          connectionId: ref.connectionId ?? '',
          instanceId: ref.instanceId ?? '',
          token: ref.token ?? '',
        },
        {
          fetch: fetchImpl(),
          baseUrl: required(env.SCRIVE_BASE_URL, 'SCRIVE_BASE_URL'),
        },
      );
      if (!outcome.accepted) return { accepted: false, reason: outcome.reason };
      const { recorded, complete, documentStatus } = outcome.result;
      return {
        accepted: true,
        log: `${ref.instanceId}: recorded ${recorded.length}, status ${documentStatus}${complete ? ', complete' : ''}`,
      };
    },
  },
};

/**
 * Fortnox (#1203, #1220) — inbound accounting, poll-only. No dispatch (nothing in a
 * scope initiates the work) and no callback (Fortnox pushes nothing); the consent
 * round that CREATES a connection is the dashboard's (`/api/integrations/fortnox/…`),
 * which relays the sealed triple here like any other credential. What this
 * registration adds is everything after that: the connect-time probe (#605) that
 * refuses a broken triple before it lands, the sweep that polls each bound scope's
 * books, and the inspection views a console reads.
 */
const FORTNOX: ConnectorRegistration = {
  provider: 'fortnox',
  grants: FORTNOX_CONNECTION_GRANTS,
  inspector: (env) => ({
    probe: async (h, row) =>
      probeFortnoxConnection(h, row, {
        fetch: fetchImpl(),
        ...(env.FORTNOX_API_BASE ? { apiBase: env.FORTNOX_API_BASE } : {}),
        ...(env.FORTNOX_OAUTH_BASE ? { oauthBase: env.FORTNOX_OAUTH_BASE } : {}),
      }),
    activity: async (h, row) => fortnoxConnectionActivity(h, row.id),
    credential: (h, row) => fortnoxCredentialSummary(h, row),
    probeCandidate: async (secret) =>
      probeFortnoxSecret(secret, {
        fetch: fetchImpl(),
        ...(env.FORTNOX_API_BASE ? { apiBase: env.FORTNOX_API_BASE } : {}),
        ...(env.FORTNOX_OAUTH_BASE ? { oauthBase: env.FORTNOX_OAUTH_BASE } : {}),
      }),
  }),
  sweep: (env) => async (h, id, o) =>
    sweepFortnoxLedger(h, id, {
      ...o,
      ...(env.FORTNOX_API_BASE ? { apiBase: env.FORTNOX_API_BASE } : {}),
      ...(env.FORTNOX_OAUTH_BASE ? { oauthBase: env.FORTNOX_OAUTH_BASE } : {}),
    }),
};

/**
 * Every connector this control plane operates. **Adding one is adding one entry here**
 * — the inspector map, the drain handlers, the sweeper map, the declared grants and the
 * callback routes in `worker.ts` are all derived from this array.
 */
export const CONNECTORS: readonly ConnectorRegistration[] = [SCRIVE, FORTNOX];

/** The `{ provider → inspector }` shape `control-plane-api` and the relay both take. */
export function connectionInspectorsFor(env: ConnectorEnv): Record<string, ConnectionInspector> {
  return Object.fromEntries(CONNECTORS.map((c) => [c.provider, c.inspector(env)]));
}

/** The `{ provider → sweeper }` shape `runPlatformSweep` takes. */
export function connectorSweepersFor(env: ConnectorEnv) {
  return Object.fromEntries(CONNECTORS.map((c) => [c.provider, c.sweep(env)]));
}

/** The `{ provider → declared grants }` shape `createControlPlaneApi` takes (#726). */
export function connectorGrantsFor(): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(CONNECTORS.map((c) => [c.provider, c.grants]));
}
