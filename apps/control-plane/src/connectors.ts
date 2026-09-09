import { globalFetch, type ConnectorHandler, type ConnectorSweeper, type ScopeHost } from '@substrat-run/kernel';
import type { ConnectFlowSpec, ConnectionInspector } from '@substrat-run/control-plane-api';
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
import {
  PLANIMA_CONNECTION_GRANTS,
  planimaConnectionActivity,
  planimaCredentialSummary,
  probePlanimaConnection,
  probePlanimaSecret,
  sweepPlanimaPlan,
} from '@substrat-run/connector-planima';

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
  /**
   * Planima host override, for a test deployment pointed at a stub. Unset means the
   * REAL host (`api.planima.se`) — safe as a default for Fortnox's reason: Planima runs
   * no separate testbed origin, so there is no wrong environment to default into.
   */
  PLANIMA_API_BASE?: string;
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
/**
 * The inspector a REGISTERED connector hands over — `ConnectionInspector` with both
 * probes made **mandatory** (#1326).
 *
 * They are optional on the interface itself because that interface describes what a
 * caller may find, and a probe genuinely cannot be written for every provider that
 * might ever exist. They are required HERE because this array is the platform's own
 * fleet, and for a provider on it "we did not write one" is not an answer a tenant can
 * act on: `POST …/connections/:id/verify` answers `501 no probe registered for provider
 * 'x'`, which reads to the person clicking **Test connection** as the provider being
 * unreachable. Planima shipped with both probes exported and neither wired, and that
 * 501 is exactly what the first tenant to press the button got.
 *
 * So the rule is: a connector carries a probe, and this type is what refuses one that
 * does not. If a provider truly offers no cheap authenticated read to probe with, say
 * so in the registration by writing a probe that returns `{ ok: false, refused: false,
 * error: '<provider> exposes no verification read' }` — a stated absence a console can
 * render, rather than a route that 501s.
 *
 * `activity` and `credential` stay optional on purpose: an absent one degrades a console
 * view, where an absent probe breaks a flow the tenant is standing in.
 */
export type RegisteredConnectionInspector = ConnectionInspector &
  Required<Pick<ConnectionInspector, 'probe' | 'probeCandidate'>>;

export interface ConnectorRegistration {
  /** The provider slug — what connection rows, dispatch kinds and grants are keyed by. */
  readonly provider: string;
  /**
   * The standing grants a connection of this provider is healed toward (#726 gap 2).
   * Read from the connector's own exported constant, never re-listed here: a second
   * copy is how the dashboard catalog came to disagree with the connector (#716).
   */
  readonly grants: readonly string[];
  /**
   * #605 — what this connector can ANSWER about a connection. Both probes are required;
   * {@link RegisteredConnectionInspector} says why.
   */
  inspector(env: ConnectorEnv): RegisteredConnectionInspector;
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
  /**
   * The BROWSER CONSENT ROUND that creates this provider's connection, when the platform
   * hosts one (connections.md §3.5.3). Absent means the credential is pasted instead —
   * a complete connector, just a different door (`/internal/connections/upsert`).
   *
   * Only the entry path is declared here, and deliberately so: the round itself lives on
   * the platform origin that owns the provider's registered `redirect_uri`, which is not
   * this worker. What this array decides is whether `/internal/connections/connect-url`
   * will mint a state for the provider at all — so a vertical asking to connect something
   * with no consent round gets a 404 naming the paste door, rather than a URL that
   * dead-ends.
   */
  readonly consent?: {
    /** Absolute path on the connect origin, taking the signed state as `?token=`. */
    readonly startPath: string;
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

const SCRIVE: ConnectorRegistration = {
  provider: 'scrive',
  grants: SCRIVE_CONNECTION_GRANTS,
  inspector: (env) => ({
    probe: async (h, row) =>
      probeScriveConnection(h, row, {
        fetch: globalFetch,
        baseUrl: required(env.SCRIVE_BASE_URL, 'SCRIVE_BASE_URL'),
      }),
    activity: async (h, row, opts) =>
      scriveConnectionActivity(h, row, {
        fetch: globalFetch,
        baseUrl: required(env.SCRIVE_BASE_URL, 'SCRIVE_BASE_URL'),
        live: opts.live,
        source: opts.source,
      }),
    credential: (h, row) => scriveCredentialSummary(h, row),
    probeCandidate: async (secret) =>
      probeScriveSecret(secret, {
        fetch: globalFetch,
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
          fetch: globalFetch,
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
 * round that CREATES a connection runs on the platform's connect origin
 * (`/api/integrations/fortnox/…`) and relays the sealed triple here like any other
 * credential. What this registration adds is everything after that: the connect-time
 * probe (#605) that refuses a broken triple before it lands, the sweep that polls each
 * bound scope's books, and the inspection views a console reads.
 *
 * `consent` is what lets a VERTICAL start that round for its own user (§3.5.3) — a
 * bureau's staff connect a client company from the bookkeeping screen they already work
 * in, with no dashboard account. Fortnox is the provider that forces the case: consent
 * is per company and there is no bulk grant, so a bureau runs the round as often as it
 * takes on new clients.
 */
const FORTNOX: ConnectorRegistration = {
  provider: 'fortnox',
  grants: FORTNOX_CONNECTION_GRANTS,
  inspector: (env) => ({
    probe: async (h, row) =>
      probeFortnoxConnection(h, row, {
        fetch: globalFetch,
        ...(env.FORTNOX_API_BASE ? { apiBase: env.FORTNOX_API_BASE } : {}),
        ...(env.FORTNOX_OAUTH_BASE ? { oauthBase: env.FORTNOX_OAUTH_BASE } : {}),
      }),
    activity: async (h, row) => fortnoxConnectionActivity(h, row.id),
    credential: (h, row) => fortnoxCredentialSummary(h, row),
    probeCandidate: async (secret) =>
      probeFortnoxSecret(secret, {
        fetch: globalFetch,
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
  consent: { startPath: '/api/integrations/fortnox/connect' },
};

/**
 * Planima (#1308) — planned facility maintenance, poll-only and read-only. No dispatch
 * (this connector never writes to Planima), no callback (Planima pushes nothing) and no
 * consent round: the credential is one static API token a person mints in Planima and
 * pastes into the dashboard's door, so `/internal/connections/upsert` is the whole
 * connect path.
 *
 * Which makes the connect-time probe the only thing standing between a typo and a
 * connection that looks healthy and syncs nothing — and makes the account question a
 * real one: a token from the wrong Planima login is perfectly valid and reads somebody
 * else's buildings. `probePlanimaSecret` reads `/organizations` and names them back, so
 * the person pasting sees whose plan they just connected.
 */
const PLANIMA: ConnectorRegistration = {
  provider: 'planima',
  grants: PLANIMA_CONNECTION_GRANTS,
  inspector: (env) => ({
    probe: async (h, row) =>
      probePlanimaConnection(h, row, {
        fetch: globalFetch,
        ...(env.PLANIMA_API_BASE ? { apiBase: env.PLANIMA_API_BASE } : {}),
      }),
    activity: async (h, row) => planimaConnectionActivity(h, row.id),
    credential: (h, row) => planimaCredentialSummary(h, row),
    probeCandidate: async (secret) =>
      probePlanimaSecret(secret, {
        fetch: globalFetch,
        ...(env.PLANIMA_API_BASE ? { apiBase: env.PLANIMA_API_BASE } : {}),
      }),
  }),
  sweep: (env) => async (h, id, o) =>
    sweepPlanimaPlan(h, id, {
      ...o,
      ...(env.PLANIMA_API_BASE ? { apiBase: env.PLANIMA_API_BASE } : {}),
    }),
};

/**
 * Every connector this control plane operates. **Adding one is adding one entry here**
 * — the inspector map, the drain handlers, the sweeper map, the declared grants and the
 * callback routes in `worker.ts` are all derived from this array.
 */
export const CONNECTORS: readonly ConnectorRegistration[] = [SCRIVE, FORTNOX, PLANIMA];

/** The `{ provider → inspector }` shape `control-plane-api` and the relay both take. */
export function connectionInspectorsFor(env: ConnectorEnv): Record<string, ConnectionInspector> {
  return Object.fromEntries(CONNECTORS.map((c) => [c.provider, c.inspector(env)]));
}

/** The `{ provider → sweeper }` shape `runPlatformSweep` takes. */
export function connectorSweepersFor(env: ConnectorEnv) {
  return Object.fromEntries(CONNECTORS.map((c) => [c.provider, c.sweep(env)]));
}

/**
 * The `{ provider → consent flow }` shape the connect-url relay takes (§3.5.3), derived
 * from the same array as everything else — so a connector that declares a round gets one
 * and a poll-only paste-credential connector cannot accidentally be offered one.
 */
export function connectFlowsFor(): Readonly<Record<string, ConnectFlowSpec | undefined>> {
  return Object.fromEntries(
    CONNECTORS.flatMap((c) => (c.consent ? [[c.provider, { startPath: c.consent.startPath }]] : [])),
  );
}

/** The `{ provider → declared grants }` shape `createControlPlaneApi` takes (#726). */
export function connectorGrantsFor(): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(CONNECTORS.map((c) => [c.provider, c.grants]));
}
