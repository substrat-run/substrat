import {
  globalFetch,
  type ConnectorHandler,
  type ConnectionBinder,
  type ConnectorSweeper,
  type MailSender,
  type ScopeHost,
} from '@substrat-run/kernel';
import { isVerticalConnectorProvider } from '@substrat-run/contracts';
import type { ConnectFlowSpec, ConnectionInspector, PaymentCheckout, ScopeSync } from '@substrat-run/control-plane-api';
import { bindingChangeRefusal, bindingOptionsRefusal, ConnectionRelayError, connectionBindingOptions } from '@substrat-run/control-plane-api';
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
  bindFortnoxScope,
  listFortnoxBindings,
  unbindFortnoxScope,
  FORTNOX_CONNECTION_GRANTS,
  fortnoxConnectionActivity,
  fortnoxCredentialSummary,
  probeFortnoxConnection,
  probeFortnoxSecret,
  pollFortnoxScope,
  sweepFortnoxLedger,
} from '@substrat-run/connector-fortnox';
import {
  bindPlanimaScope,
  listPlanimaBindings,
  unbindPlanimaScope,
  PLANIMA_CONNECTION_GRANTS,
  planimaConnectionActivity,
  planimaCredentialSummary,
  probePlanimaConnection,
  probePlanimaSecret,
  sweepPlanimaPlan,
} from '@substrat-run/connector-planima';
import {
  WOOCOMMERCE_CONNECTION_GRANTS,
  WooCommerceKeyRefusal,
  bindWooCommerceScope,
  listWooCommerceBindings,
  prepareWooCommerceCandidate,
  probeWooCommerceConnection,
  probeWooCommerceSecret,
  sweepWooCommerce,
  unbindWooCommerceScope,
  woocommerceBindingHealth,
  woocommerceConnectionActivity,
  woocommerceCredentialSummary,
} from '@substrat-run/connector-woocommerce';
import {
  MICROSOFT365_CONNECTION_GRANTS,
  bindMicrosoft365Scope,
  listMicrosoft365Bindings,
  unbindMicrosoft365Scope,
  microsoft365FilesConnector,
  sweepMicrosoft365Files,
  microsoft365Certificate,
  microsoft365CredentialSummary,
  microsoft365MailSender,
  prepareMicrosoft365,
  probeMicrosoft365Connection,
  probeMicrosoft365Secret,
} from '@substrat-run/connector-microsoft365';
import {
  BOLAGSVERKET_CONNECTION_GRANTS,
  bindBolagsverketScope,
  bolagsverketConnector,
  bolagsverketCredentialSummary,
  listBolagsverketBindings,
  unbindBolagsverketScope,
  probeBolagsverketConnection,
  probeBolagsverketSecret,
  sweepBolagsverket,
  bolagsverketCallConfig,
  bolagsverketEgressHosts,
  type BolagsverketConnectorOptions,
} from '@substrat-run/connector-bolagsverket';
import {
  STRIPE_CALLBACK_ROUTE,
  STRIPE_CONNECTION_GRANTS,
  StripeCheckoutRefusal,
  StripeKeyRefusal,
  bindStripeScope,
  createStripeCheckout,
  handleStripeCallback,
  listStripeBindings,
  prepareStripeCandidate,
  probeStripeConnection,
  probeStripeSecret,
  stripeConnectionActivity,
  stripeCredentialSummary,
  sweepStripe,
  unbindStripeScope,
  type StripeConnectorOptions,
} from '@substrat-run/connector-stripe';
import {
  MAIL_IN_CONNECTION_GRANTS,
  probeMailInConnection,
  probeMailInSecret,
  sweepMailIn,
} from '@substrat-run/connector-mail-in';
import { mailInInboundDeps, type MailInEnv } from './mail-in.js';
import { placedProbes, type ConnectorScriptEnv } from './connector-scripts.js';

/**
 * The env slice the connectors read — declared HERE rather than in `worker.ts`, so a
 * second connector's configuration arrives with the connector instead of in a second
 * file. `Env` extends this, which is what makes one entry below the whole edit.
 */
export interface ConnectorEnv extends MailInEnv, ConnectorScriptEnv {
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
   * #2422: the scopes this deployment's Fortnox Connect asks for, when the dashboard's
   * `FORTNOX_SCOPES` overrides the connector's default. A consent lacking any of them shows as
   * "needs re-consent", so the two must name the same set. Unset means the connector's default.
   */
  FORTNOX_SCOPES?: string;
  /**
   * Planima host override, for a test deployment pointed at a stub. Unset means the
   * REAL host (`api.planima.se`) — safe as a default for Fortnox's reason: Planima runs
   * no separate testbed origin, so there is no wrong environment to default into.
   */
  PLANIMA_API_BASE?: string;
  /**
   * Microsoft host overrides (#2100), for a test deployment pointed at a stub. Unset means the
   * REAL hosts (`login.microsoftonline.com`, `graph.microsoft.com`) — safe for Fortnox's
   * reason: a test tenant lives on the production hosts, so there is no wrong environment.
   */
  MICROSOFT365_LOGIN_BASE?: string;
  MICROSOFT365_GRAPH_BASE?: string;
  /**
   * Bolagsverket environment (#2855): `test` for the acceptance environment, anything else
   * or unset for production. Bolagsverket issues a separate pair per environment, so a
   * deployment whose tenants paste test pairs sets this; the host overrides point either
   * one at a stub.
   */
  BOLAGSVERKET_ENV?: string;
  BOLAGSVERKET_TOKEN_URL?: string;
  BOLAGSVERKET_API_BASE?: string;
  /**
   * Stripe API override (#3189), for a test deployment pointed at a stub. Unset means the REAL
   * host (`api.stripe.com`) — safe as a default for Fortnox's reason: test mode is a property of
   * the tenant's key, not a separate origin, so there is no wrong environment to default into.
   */
  STRIPE_API_BASE?: string;
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
  /*
   * `host` is the control plane's own, for a connector that lands its answer from the dispatch
   * itself (Bolagsverket opens the scope as the connection with `host.getConnectorScope`). A
   * dispatch's `ConnectorContext` holds no scope, and a sweep or a callback is handed the same
   * host already.
   */
  dispatch?(env: ConnectorEnv, host: ScopeHost): ConnectorHandler;
  /** The poll floor (#574): re-read the provider's truth and write it back. */
  sweep(env: ConnectorEnv): ConnectorSweeper;
  /**
   * #2672: poll ONE scope's bindings now, for the sync relay, inside the budget and deadline a pass
   * has. Absent, the relay answers 501 for the provider: its sweep can only poll a whole connection.
   * A provider with `sweepEveryMinutes` must not add one before the cadence ignores a scope's own
   * poll, or a manual poll of one scope postpones the connection's other bindings.
   */
  syncScope?(env: ConnectorEnv): ScopeSync;
  /** Poll this provider's connections no more often than this many minutes; absent means every pass. */
  readonly sweepEveryMinutes?: number;
  /**
   * #2316: this provider's bindings record the connection's `externalAccountRef`, because one
   * (tenant, vertical) holds a connection per external account and the sweep opens the credential
   * by it. A binding that does not carry the connection's account is re-written by the connector
   * pass. Absent for a provider with one connection per (tenant, vertical). Fortnox (account from a
   * credential field) and Stripe (account from the probe, #3211) set it.
   */
  readonly accountOnBinding?: true;
  /**
   * #2611: the platform mints this provider's connections itself — a mail-in address is requested
   * for a scope, never pasted — so no dashboard door connects it, and `pnpm lint:connector-grants`
   * does not ask for one. Its `probeCandidate` refuses every credential, so the paste relay cannot
   * create one either.
   */
  readonly minted?: true;
  /**
   * #2732: this provider's connector opens a scope's OWN connection (`openConnection`'s owner
   * selector) wherever it opens one, so a scope may hold its own through the relay's
   * `owner: 'scope'` and bind it, and the tenant's inspection routes open it through the inspector
   * (#3201). Absent, its connections are the tenant's, and the relay refuses a scope's own: its sweep,
   * dispatch and inspection open the tenant's connection by key. WooCommerce sets it (#3201).
   */
  readonly scopeOwned?: true;
  /**
   * The webhook ingress, for a provider that calls back (#96). Absent is a complete
   * connector — push collapses the sweep's latency, it never replaces it.
   *
   * `route` is a Hono `:param` pattern; whatever it captures is handed to `handle` as
   * the ref. Unauthenticated by design where the provider signs nothing: the token
   * minted into the URL is the whole authentication, and the handler is what checks it.
   * `request` is the call's raw body and headers, for a provider that signs them (Stripe,
   * #3189): a signature is over the exact bytes, so the route reads the body as text and
   * parses nothing before the handler has checked it.
   */
  readonly callback?: {
    readonly route: string;
    handle(
      env: ConnectorEnv,
      host: ScopeHost,
      ref: Record<string, string | undefined>,
      request: { body: string; headers: { get(name: string): string | null } },
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
  /**
   * #2098 — this connection can send mail as addresses the tenant owns. The email relay
   * routes a vertical's message to it when the message's `from` is one of its `senders`.
   * Absent is a complete connector that sends no mail.
   *
   * The dashboard door says the same thing with `sendsMail` (`pnpm lint:connector-grants`
   * holds the two equal), so a tenant can tell from the door that this connection will send
   * as them.
   */
  mail?(env: ConnectorEnv): MailSender;
  /**
   * #3189 — this connection takes payments: the checkout relay opens a hosted checkout through it,
   * inside the request, for the scope it is bound to. Absent is a complete connector that takes no
   * money; the relay answers 501 for it. A refusal the vertical should read is a
   * `ConnectionRelayError`; anything else is the provider not answering, said as a 503.
   */
  checkout?(env: ConnectorEnv): PaymentCheckout;
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
  sweep: (env) => async (h, id, o) => {
    const result = await sweepScriveReconciliations(h, id, {
      ...o,
      baseUrl: required(env.SCRIVE_BASE_URL, 'SCRIVE_BASE_URL'),
    });
    // #1927: a signature Scrive holds and the instance does not needs a person. The
    // ledger row carries it for the activity view; this puts it in the worker's logs
    // too. Ids only — the reasons name the parties.
    if (result.needsAttention.length > 0) {
      console.warn('scrive-sweep: needs attention', {
        connectionId: id,
        requests: result.needsAttention.map(({ instanceId, requestId, signedAt }) => ({
          instanceId,
          requestId,
          signedAt,
        })),
      });
    }
    return result;
  },
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
/** #2422: the set a consent is held to, when this deployment asks for other scopes than the default. */
const fortnoxConsentScopes = (env: ConnectorEnv): { consentScopes?: string[] } => {
  const scopes = (env.FORTNOX_SCOPES ?? '').split(/[\s,]+/).filter(Boolean);
  return scopes.length > 0 ? { consentScopes: scopes } : {};
};

const FORTNOX: ConnectorRegistration = {
  provider: 'fortnox',
  grants: FORTNOX_CONNECTION_GRANTS,
  accountOnBinding: true,
  inspector: (env) => ({
    // #2316: the company rides on the binding, so the sweep opens THIS company's credential when a
    // bureau has several connected.
    bindScope: (h, row, target) =>
      bindFortnoxScope(h, { ...target, connectionId: row.id, externalAccountRef: row.externalAccountRef }),
    bindings: (h, row) => listFortnoxBindings(h, row.id),
    unbindScope: (h, row, scopeId) => unbindFortnoxScope(h, row.id, scopeId),
    probe: async (h, row) =>
      probeFortnoxConnection(h, row, {
        fetch: globalFetch,
        ...(env.FORTNOX_API_BASE ? { apiBase: env.FORTNOX_API_BASE } : {}),
        ...(env.FORTNOX_OAUTH_BASE ? { oauthBase: env.FORTNOX_OAUTH_BASE } : {}),
        ...fortnoxConsentScopes(env),
      }),
    activity: async (h, row) => fortnoxConnectionActivity(h, row.id),
    credential: (h, row) => fortnoxCredentialSummary(h, row),
    probeCandidate: async (secret) =>
      probeFortnoxSecret(secret, {
        fetch: globalFetch,
        ...(env.FORTNOX_API_BASE ? { apiBase: env.FORTNOX_API_BASE } : {}),
        ...(env.FORTNOX_OAUTH_BASE ? { oauthBase: env.FORTNOX_OAUTH_BASE } : {}),
        ...fortnoxConsentScopes(env),
      }),
  }),
  sweep: (env) => async (h, id, o) =>
    sweepFortnoxLedger(h, id, {
      ...o,
      ...(env.FORTNOX_API_BASE ? { apiBase: env.FORTNOX_API_BASE } : {}),
      ...(env.FORTNOX_OAUTH_BASE ? { oauthBase: env.FORTNOX_OAUTH_BASE } : {}),
      ...fortnoxConsentScopes(env),
    }),
  syncScope: (env) => (h, row, scopeId) =>
    pollFortnoxScope(h, row.id, scopeId, {
      fetch: globalFetch,
      ...(env.FORTNOX_API_BASE ? { apiBase: env.FORTNOX_API_BASE } : {}),
      ...(env.FORTNOX_OAUTH_BASE ? { oauthBase: env.FORTNOX_OAUTH_BASE } : {}),
      ...fortnoxConsentScopes(env),
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
  // 250 facilities need at least 751 reads. Twelve polls/day spend 9,012 of Planima's
  // 10,000 daily calls; a 105-minute interval would spend more than the allowance.
  // Two hours also leaves room for pagination and connect-time probes.
  sweepEveryMinutes: 120,
  inspector: (env) => ({
    bindScope: (h, row, target) => bindPlanimaScope(h, { ...target, connectionId: row.id }),
    bindings: (h, row) => listPlanimaBindings(h, row.id),
    unbindScope: (h, row, scopeId) => unbindPlanimaScope(h, row.id, scopeId),
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
 * WooCommerce (#3136): a store's products and orders, read-only, landed in the provider-neutral
 * commerce shape through the consuming vertical's own operation. The credential is the store's URL
 * and a REST API key with Read permission, pasted into the dashboard's door; the URL is tenant
 * input, so the connector judges it before calling it (`storeBaseUrl`). `probeWooCommerceSecret`
 * tells a wrong address from a wrong key, and names the store the key reads.
 *
 * A connection is keyed on that store (#3219, `accountFromProbe`): a key for the same store rotates it
 * and keeps its cursors, a key for another store becomes a connection of its own, and each binding
 * records which (`accountOnBinding`). `prepareCandidate` pins each key to its store, which is what
 * refuses another store's key for a connection made before keying.
 */
const WOOCOMMERCE: ConnectorRegistration = {
  provider: 'woocommerce',
  grants: WOOCOMMERCE_CONNECTION_GRANTS,
  // An idle pass is three requests to the merchant's own server; a quarter of an hour keeps
  // orders fresh without polling a small shop's PHP every pass.
  sweepEveryMinutes: 15,
  // #3219: an app may hold a connection per store, so the sweep opens one by the store its binding
  // records.
  accountOnBinding: true,
  // #3201: a scope may connect its own shop, so a tenant's stores each receive only their own shop's
  // records. Every open names the owner: the binding records it, the inspector reads it off the row.
  scopeOwned: true,
  inspector: () => ({
    // The key does not say which store it reads beyond the address it was pasted with, and the store
    // names itself: the connection is keyed on that, on every door a key comes in by.
    accountFromProbe: true,
    bindScope: (h, row, target) =>
      bindWooCommerceScope(h, {
        ...target,
        connectionId: row.id,
        externalAccountRef: row.externalAccountRef,
        ownerScopeId: row.ownerScopeId,
      }),
    // Each with its health (#3241), which a scope's `listBindings` reads.
    bindings: async (h, row) => (await listWooCommerceBindings(h, row.id)).map((b) => ({ ...b, health: woocommerceBindingHealth(b) })),
    unbindScope: (h, row, scopeId) => unbindWooCommerceScope(h, row.id, scopeId),
    probe: async (h, row) => probeWooCommerceConnection(h, row, { fetch: globalFetch }),
    activity: async (h, row) => woocommerceConnectionActivity(h, row.id),
    credential: (h, row) => woocommerceCredentialSummary(h, row),
    probeCandidate: async (secret) => probeWooCommerceSecret(secret, { fetch: globalFetch }),
    // Pins the key to its store. A key for another store than a connection made before #3219 holds
    // (no account ref) is refused here, before the store, with nothing stored.
    prepareCandidate: async (candidate, previous) => {
      try {
        return await prepareWooCommerceCandidate({ fetch: globalFetch })(candidate, previous);
      } catch (err) {
        if (err instanceof WooCommerceKeyRefusal) throw new ConnectionRelayError(err.message, err.status);
        throw err;
      }
    },
  }),
  sweep: () => async (h, id, o) => sweepWooCommerce(h, id, o),
};

/**
 * Stripe (#3189) — a vertical takes payments through its tenant's own Stripe account. The
 * credential is one restricted key, pasted into the dashboard's door; the probe names the account,
 * says whether it is live, and whether the key may register the webhook endpoint. The connection is
 * keyed on that account and mode (#3211, `accountFromProbe`): a key for the same one rotates it, a
 * key for another becomes a connection of its own, and each binding records which (`accountOnBinding`).
 *
 * The only connector with all three halves of the payment round trip: `checkout` opens a hosted
 * session inside the vertical's request (the relay), `callback` hears Stripe's webhook — signed
 * over the raw body, and only a hint, since the outcome is read back from Stripe — and `sweep`
 * re-reads every open session, so an account where the key may not register an endpoint is
 * complete, just slower. Outcomes land through the binding's operation as `paymentChange`.
 */
function stripeOptions(env: ConnectorEnv): StripeConnectorOptions {
  return {
    fetch: globalFetch,
    ...(env.STRIPE_API_BASE ? { apiBase: env.STRIPE_API_BASE } : {}),
    // The webhook endpoint is registered under this worker's own origin; without it, poll-only.
    ...(env.PLATFORM_CP_URL ? { callbackBase: env.PLATFORM_CP_URL } : {}),
  };
}

const STRIPE: ConnectorRegistration = {
  provider: 'stripe',
  grants: STRIPE_CONNECTION_GRANTS,
  // #3211: an app may hold a connection per Stripe account, so the sweep opens one by the account
  // its binding records.
  accountOnBinding: true,
  inspector: (env) => ({
    // The key does not say which account it reaches, and the probe does: the connection is keyed on
    // the account and mode it names, on every door a key comes in by.
    accountFromProbe: true,
    bindScope: (h, row, target) =>
      bindStripeScope(h, { ...target, connectionId: row.id, externalAccountRef: row.externalAccountRef }),
    bindings: (h, row) => listStripeBindings(h, row.id),
    unbindScope: (h, row, scopeId) => unbindStripeScope(h, row.id, scopeId),
    probe: async (h, row) => probeStripeConnection(h, row, stripeOptions(env)),
    activity: async (h, row) => stripeConnectionActivity(h, row.id),
    credential: (h, row) => stripeCredentialSummary(h, row),
    probeCandidate: async (secret) => probeStripeSecret(secret, stripeOptions(env)),
    // Pins the key to its account and mode. A key for another one than a connection made before
    // #3211 holds (no account ref) is refused here, before the store, with nothing stored.
    prepareCandidate: async (candidate, previous) => {
      try {
        return await prepareStripeCandidate(stripeOptions(env))(candidate, previous);
      } catch (err) {
        if (err instanceof StripeKeyRefusal) throw new ConnectionRelayError(err.message, err.status);
        throw err;
      }
    },
  }),
  sweep: (env) => async (h, id, o) => sweepStripe(h, id, { ...stripeOptions(env), fetch: o.fetch }),
  checkout: (env) => async (h, row, scopeId, request) => {
    try {
      return await createStripeCheckout(h, row, scopeId, request, stripeOptions(env));
    } catch (err) {
      if (err instanceof StripeCheckoutRefusal) throw new ConnectionRelayError(err.message, err.status);
      // Stripe or the network, in words that may carry the account's detail: staff's log, not the answer.
      console.error('stripe-checkout: failed', { connectionId: row.id, scopeId, error: err instanceof Error ? err.message : String(err) });
      throw new ConnectionRelayError('Stripe did not answer the checkout; ask again in a moment', 503);
    }
  },
  callback: {
    route: STRIPE_CALLBACK_ROUTE,
    handle: async (env, host, ref, request) => {
      const outcome = await handleStripeCallback(
        host,
        { connectionId: ref.connectionId ?? '', token: ref.token ?? '' },
        { body: request.body, signature: request.headers.get('Stripe-Signature') },
        stripeOptions(env),
      );
      if (!outcome.accepted) return { accepted: false, reason: outcome.reason };
      const { eventId, type, checkoutId, status, landed } = outcome.result;
      return { accepted: true, log: `${eventId} ${type}: ${checkoutId ?? 'not a checkout'}${status ? ` ${status}` : ''}${landed ? ', landed' : ''}` };
    },
  },
};

/**
 * Bolagsverket (#2855): organisation-number validation over the free value-datasets API. The
 * credential is the tenant's own client id and secret, pasted into the dashboard's door, so
 * the provider's 60-a-minute limit is metered per tenant. No consent round and no callback. The
 * probes mint a token and ping; the token names no account, so a probe reports the environment
 * and the granted scopes.
 *
 * The dispatch is the lookup: a vertical emits `bolagsverket.organisation-lookup-requested`, and
 * the dispatch looks the number up with the tenant's connection and lands the answer through the
 * operation the vertical's `connections` landing declares, as the connection. It lands from the
 * dispatch rather than from a sweep, so the answer arrives with the router's drain kick instead of
 * at the next 15-minute pass. The landing pass grants the declared key and binds each install with
 * the binding verbs below, as it does Planima's.
 */
function bolagsverketOptions(env: ConnectorEnv): BolagsverketConnectorOptions {
  return {
    fetch: globalFetch,
    environment: env.BOLAGSVERKET_ENV === 'test' ? 'test' : 'prod',
    ...(env.BOLAGSVERKET_TOKEN_URL ? { tokenUrl: env.BOLAGSVERKET_TOKEN_URL } : {}),
    ...(env.BOLAGSVERKET_API_BASE ? { apiBase: env.BOLAGSVERKET_API_BASE } : {}),
  };
}

/**
 * The pilot of a connector run as its own script (docs/rfc/connector-scripts.md, phase 1): with
 * `bolagsverket` in `REMOTE_CONNECTORS` the probes go to `substrat-connector-bolagsverket` through
 * the router, and without it they run here, as they always have. The credential summary is a read
 * of the platform's own store and no provider call, so it stays here either way, and so does the
 * sweep, which calls nothing.
 */
const BOLAGSVERKET: ConnectorRegistration = {
  provider: 'bolagsverket',
  grants: BOLAGSVERKET_CONNECTION_GRANTS,
  inspector: (env) => ({
    ...placedProbes(env, {
      provider: 'bolagsverket',
      local: (fetch) => ({
        probe: async (h, row) => probeBolagsverketConnection(h, row, { ...bolagsverketOptions(env), fetch }),
        probeCandidate: async (secret) => probeBolagsverketSecret(secret, { ...bolagsverketOptions(env), fetch }),
      }),
      config: () => bolagsverketCallConfig(bolagsverketOptions(env)),
      hosts: () => bolagsverketEgressHosts(bolagsverketOptions(env)),
    }),
    credential: (h, row) => bolagsverketCredentialSummary(h, row),
    bindScope: (h, row, target) => bindBolagsverketScope(h, { ...target, connectionId: row.id }),
    bindings: (h, row) => listBolagsverketBindings(h, row.id),
    unbindScope: (h, row, scopeId) => unbindBolagsverketScope(h, row.id, scopeId),
  }),
  // Always in-process, whatever REMOTE_CONNECTORS says: the script pilot serves the probes only.
  dispatch: (env, host) =>
    bolagsverketConnector({
      ...bolagsverketOptions(env),
      scope: (connectionId, scopeId) => host.getConnectorScope(connectionId, scopeId),
    }),
  sweep: () => sweepBolagsverket,
};

/**
 * Microsoft 365 (#2100) — a tenant's own mailbox, as a `MailSender` behind the email relay
 * (#2098), and one Teams channel's folder of its SharePoint site (#2101). App-only Graph in the
 * tenant's directory; no callback, no consent round (the app registration is the tenant's, so the
 * credential is typed into the door).
 *
 * `prepareCandidate` is what makes the certificate path work: with no client secret it
 * generates this connection's keypair on the plane, before the probe, and keeps it across an
 * edit — so the private key is made where it is sealed and the tenant only ever handles the
 * certificate. The connection is saved before the tenant can upload that certificate, which is
 * why the connector reports "not on the app registration yet" as inconclusive. It also rotates
 * the certificate: within 30 days of its end it mints a successor beside it, and promotes the
 * successor on a later save once Entra accepts it (`prepareMicrosoft365`).
 *
 * The channel folder is a binding (`bindScope`): the folder's drive path, resolved to its item id
 * when bound. Writes are a dispatch of `microsoft365.channel-files-requested`; reads are the
 * sweep, following the drive's change feed and landing what is in the folder through the
 * binding's operation.
 */
const MICROSOFT365: ConnectorRegistration = {
  provider: 'microsoft365',
  grants: MICROSOFT365_CONNECTION_GRANTS,
  inspector: (env) => ({
    bindScope: (h, row, target) => {
      if (!target.folder) throw new Error('a Microsoft 365 binding names the channel folder');
      return bindMicrosoft365Scope(
        h,
        { ...target, folder: target.folder, connectionId: row.id },
        microsoft365Options(env),
      );
    },
    bindings: (h, row) => listMicrosoft365Bindings(h, row.id),
    unbindScope: (h, row, scopeId) => unbindMicrosoft365Scope(h, row.id, scopeId),
    probe: async (h, row) => probeMicrosoft365Connection(h, row, microsoft365Options(env)),
    credential: (h, row) => microsoft365CredentialSummary(h, row),
    probeCandidate: async (secret) => probeMicrosoft365Secret(secret, microsoft365Options(env)),
    prepareCandidate: prepareMicrosoft365({ ...microsoft365Options(env), commonName: 'Substrat' }),
    certificate: (h, row) => microsoft365Certificate(h, row),
  }),
  dispatch: (env) => microsoft365FilesConnector(microsoft365Options(env)),
  sweep: (env) => async (h, id, o) => sweepMicrosoft365Files(h, id, { ...microsoft365Options(env), fetch: o.fetch }),
  mail: (env) => microsoft365MailSender(microsoft365Options(env)),
};

/**
 * Inbound mail (#2611) — a scope's address on the platform's receiving subdomain. Each address is
 * its own connection, minted by the platform when a scope asks (`/internal/mail-in/address`, the
 * dashboard), so there is no door and no credential. Email Routing hands each message to the
 * `email()` handler, which accepts or refuses it at SMTP time; this sweep is the retry floor for
 * deliveries that did not land straight after accept. No dispatch: nothing in a scope sends
 * through an address.
 */
const MAIL_IN: ConnectorRegistration = {
  provider: 'mail-in',
  grants: MAIL_IN_CONNECTION_GRANTS,
  minted: true,
  inspector: () => ({
    probe: async (h, row) => probeMailInConnection(h, row),
    probeCandidate: async () => probeMailInSecret(),
  }),
  sweep: (env) => async (h, id) => sweepMailIn(h, mailInInboundDeps(env), id),
};

function microsoft365Options(env: ConnectorEnv) {
  return {
    fetch: globalFetch,
    ...(env.MICROSOFT365_LOGIN_BASE ? { loginBase: env.MICROSOFT365_LOGIN_BASE } : {}),
    ...(env.MICROSOFT365_GRAPH_BASE ? { graphBase: env.MICROSOFT365_GRAPH_BASE } : {}),
  };
}

/**
 * Every connector this control plane operates. **Adding one is adding one entry here**
 * — the inspector map, the drain handlers, the sweeper map, the declared grants and the
 * callback routes in `worker.ts` are all derived from this array.
 */
export const CONNECTORS: readonly ConnectorRegistration[] = [SCRIVE, FORTNOX, PLANIMA, WOOCOMMERCE, STRIPE, BOLAGSVERKET, MICROSOFT365, MAIL_IN];

/**
 * The `{ provider → inspector }` shape `control-plane-api` and the relay both take. A `scopeOwned`
 * registration's inspector says so (#3201), so the inspection routes open a scope's own row through it.
 */
export function connectionInspectorsFor(env: ConnectorEnv): Record<string, ConnectionInspector> {
  return Object.fromEntries(
    CONNECTORS.map((c) => [c.provider, c.scopeOwned ? { ...c.inspector(env), scopeOwned: true as const } : c.inspector(env)]),
  );
}

/**
 * #2732: whether a scope may hold its own connection of `provider`: a vertical-defined provider
 * (its connector call opens the row it is handed, owner and all), or a registration that says so.
 * WooCommerce does (#3201).
 */
export function scopeOwnable(provider: string): boolean {
  return isVerticalConnectorProvider(provider) || CONNECTORS.some((c) => c.provider === provider && c.scopeOwned);
}

/** The `{ provider → sweeper }` shape `runPlatformSweep` takes. */
export function connectorSweepersFor(env: ConnectorEnv) {
  return Object.fromEntries(CONNECTORS.map((c) => [c.provider, c.sweep(env)]));
}

/** Provider poll intervals, from the same registrations as their sweepers. */
export function connectorSweepEveryMinutesFor(): Record<string, number> {
  return Object.fromEntries(CONNECTORS.flatMap((c) => c.sweepEveryMinutes ? [[c.provider, c.sweepEveryMinutes]] : []));
}

/**
 * The `{ provider → binder }` shape `runPlatformSweep`'s `connectionLandings` takes (#2316): the
 * same `bindScope` and `bindings` the staff binding door calls, so a binding a vertical declares is
 * written by the code a person's would be, refused on the same missing key, and validated by the
 * same options schema. A provider whose inspector binds nothing is absent, and its connections are
 * never bound from a declaration.
 */
export function connectionBindersFor(env: ConnectorEnv): Record<string, ConnectionBinder> {
  return Object.fromEntries(
    CONNECTORS.flatMap((c) => {
      const inspector = c.inspector(env);
      const { bindScope, bindings } = inspector;
      if (!bindScope || !bindings) return [];
      const options = connectionBindingOptions(c.provider);
      const binder: ConnectionBinder = {
        list: (h, row) => bindings(h, row),
        bind: (h, row, target) => bindScope(h, row, target as Parameters<typeof bindScope>[2]),
        ...(inspector.unbindScope ? { unbind: inspector.unbindScope } : {}),
        ...(['fortnox', 'planima', 'woocommerce', 'stripe', 'bolagsverket'].includes(c.provider)
          ? {
              bindBeforeGrant: (h: ScopeHost, row: Parameters<typeof bindScope>[1], target: Parameters<typeof bindScope>[2]) =>
                bindScope(h, row, { ...target, grantPreflighted: true } as Parameters<typeof bindScope>[2]),
            }
          : {}),
        options: (raw, current) => {
          if (c.provider === 'fortnox') {
            const parsed = options.parse(raw ?? {}) as {
              kind?: 'ledger' | 'supplier-invoice';
              form?: 'summary' | 'sie';
              years?: 'all' | number;
              firstPass?: 'all' | number;
              writeback?: { read: string; record: string };
            };
            // An option the binding holds and the call leaves out is kept, as every other provider's
            // merge keeps it. Kind is not: a kind left out is `ledger`, and a change of kind is refused.
            const held = current as
              | { form?: 'summary' | 'sie'; years?: 'all' | number; firstPass?: 'all' | number; writeback?: { read: string; record: string } }
              | undefined;
            const ledger = (parsed.kind ?? 'ledger') === 'ledger';
            const form = parsed.form ?? (ledger ? held?.form : undefined);
            const next = {
              kind: parsed.kind,
              form,
              years: parsed.years ?? (form === 'sie' ? held?.years : undefined),
              firstPass: parsed.firstPass ?? (ledger ? undefined : held?.firstPass),
              writeback: parsed.writeback ?? (ledger ? undefined : held?.writeback),
            };
            const refusal = bindingOptionsRefusal(c.provider, next) ?? bindingChangeRefusal(c.provider, current as { kind?: string } | undefined, parsed);
            if (refusal) throw new Error(refusal);
            return next;
          }
          return options.parse({
            ...(current ? options.strip().parse(current) : {}),
            ...(raw ?? {}),
          });
        },
        ...(c.accountOnBinding
          ? {
              // A binding written before it recorded the company opens whichever connection
              // (tenant, vertical) finds, and throws once a second company is connected.
              stale: (binding, row) =>
                ((binding as { externalAccountRef?: string | null }).externalAccountRef ?? null) !== row.externalAccountRef,
            }
          : {}),
      };
      return [[c.provider, binder]];
    }),
  );
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

/** The `{ provider → checkout }` shape the checkout relay opens a payment through (#3189). */
export function paymentCheckoutsFor(env: ConnectorEnv): Readonly<Record<string, PaymentCheckout>> {
  return Object.fromEntries(CONNECTORS.flatMap((c) => (c.checkout ? [[c.provider, c.checkout(env)]] : [])));
}

/** The `{ provider → mail sender }` shape the email relay routes a tenant `from` through (#2098). */
export function mailSendersFor(env: ConnectorEnv): Readonly<Record<string, MailSender>> {
  return Object.fromEntries(CONNECTORS.flatMap((c) => (c.mail ? [[c.provider, c.mail(env)]] : [])));
}

/** The `{ provider → declared grants }` shape `createControlPlaneApi` takes (#726). */
export function connectorGrantsFor(): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(CONNECTORS.map((c) => [c.provider, c.grants]));
}
