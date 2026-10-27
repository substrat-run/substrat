/**
 * Vertical-defined connectors (docs/architecture/vertical-connectors.md §5, §6): the value a
 * vertical defines its connectors with, and the platform's call into them.
 *
 * `defineConnectors` is read twice. `substrat push` imports it for the static half
 * (`declarations()`, plain data, because the CLI cannot import this package), and the worker
 * mounts it on `mountPlatformSurface`, whose `/internal/connector-call` route hands each call to
 * {@link runConnectorCall}. That call is one connection's worth of the platform: the opened
 * credential, the connector's state carried in the request, and a door back into the scope that
 * invokes as the connection principal and nothing else. State writes leave in the response and
 * the platform applies them only when the call succeeded.
 */
import {
  attachmentRecord,
  connectionProbe,
  connectorBindResult,
  connectorCallRequest,
  connectorCallResponse,
  connectorSweepResult,
  verticalConnectorDeclarations,
  verticalConnectorProvider,
  CONNECTOR_CALL_MAX_USES,
  type ConnectionUseOutcomeWire,
  type ConnectorCallRequest,
  type ConnectorCallResponse,
  type DomainEvent,
  type VerticalConnectorDeclaration,
  type VerticalConnectorField,
  type z,
} from '@substrat-run/contracts';
import {
  ConnectorRefusal,
  deadlineFetch,
  isConnectorRefusal,
  settleConnectionUse,
  type ConnectionContext,
  type ConnectorOptions,
  type FetchLike,
  type OpenedAttachment,
  type ScopeHost,
  type ScopedConnectionContext,
} from '@substrat-run/kernel';
import type { VerticalScopeHost } from './index.js';
import { externalInput } from './wire.js';

type ProbeNullables = 'accountRef' | 'accountLabel' | 'error';
/** What a probe answers: `{ ok: true }` alone is enough; the three nullables default to null. */
export type ConnectionProbeInput = Omit<z.input<typeof connectionProbe>, ProbeNullables> &
  Partial<Pick<z.input<typeof connectionProbe>, ProbeNullables>>;

const probeAnswer = (result: ConnectionProbeInput) =>
  connectionProbe.parse({ accountRef: null, accountLabel: null, error: null, ...result });

export type ConnectorCallRole = ConnectorCallRequest['role'];

/** One connector a vertical defines (§5.1): its declaration and its code, in one value. */
export interface ConnectorDefinition {
  label: string;
  description: string;
  monogram?: string;
  fields: VerticalConnectorField[];
  /** The connection's standing grants. */
  grants?: string[];
  /** The event types routed to `dispatch()`. */
  events?: string[];
  /** Before the credential is stored: does it work, and for whom? */
  probeCandidate(secret: Readonly<Record<string, string>>, io: { fetch: FetchLike }): Promise<ConnectionProbeInput>;
  /** The live connection. */
  probe(ctx: ConnectionContext): Promise<ConnectionProbeInput>;
  /** Validate and normalise a binding's options before the platform stores them. */
  bind?(ctx: ScopedConnectionContext, options: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** The poll floor, once per bound scope. */
  sweep?(ctx: ScopedConnectionContext): Promise<{ landed?: number; more?: boolean } | void>;
  /** One routed event. */
  dispatch?(ctx: ScopedConnectionContext, event: DomainEvent): Promise<void>;
}

/** `Symbol.for`, so a second copy of this package in one bundle still recognises the value. */
const BRAND = Symbol.for('@substrat-run/vertical-host/connectors');

export interface VerticalConnectors {
  readonly [BRAND]: true;
  readonly providers: readonly string[];
  /** The static half the push manifest carries, validated. Plain data. */
  declarations(): VerticalConnectorDeclaration[];
  definition(provider: string): ConnectorDefinition | undefined;
}

export function isVerticalConnectors(value: unknown): value is VerticalConnectors {
  return typeof value === 'object' && value !== null && (value as { [BRAND]?: unknown })[BRAND] === true;
}

export function defineConnectors(defs: Record<string, ConnectorDefinition>): VerticalConnectors {
  for (const [provider, def] of Object.entries(defs)) {
    if (!verticalConnectorProvider.safeParse(provider).success) {
      throw new Error(`defineConnectors: '${provider}' is not a vertical-defined provider — name it <namespace>.<name>, e.g. 'acme.docbox'`);
    }
    if (typeof def.probeCandidate !== 'function' || typeof def.probe !== 'function') {
      throw new Error(`defineConnectors: ${provider} must define probeCandidate and probe — a connection a tenant cannot test is a door that 501s`);
    }
    const routed = (def.events ?? []).length > 0;
    if (routed && !def.dispatch) {
      throw new Error(`defineConnectors: ${provider} routes events (${def.events!.join(', ')}) but defines no dispatch`);
    }
    if (!routed && def.dispatch) {
      throw new Error(`defineConnectors: ${provider} defines dispatch but routes no events to it`);
    }
  }
  const table = new Map(Object.entries(defs));
  return {
    [BRAND]: true,
    providers: Object.freeze([...table.keys()]),
    declarations() {
      return verticalConnectorDeclarations.parse(
        [...table].map(([provider, d]) => ({
          provider,
          label: d.label,
          description: d.description,
          ...(d.monogram !== undefined ? { monogram: d.monogram } : {}),
          fields: d.fields,
          grants: d.grants ?? [],
          events: d.events ?? [],
          sweeps: typeof d.sweep === 'function',
          binds: typeof d.bind === 'function',
          dispatches: typeof d.dispatch === 'function',
        })),
      );
    },
    definition: (provider) => table.get(provider),
  };
}

/**
 * Register every routed event of every connector on `host`, for ROUTING ONLY — the CP-less
 * host never runs the handler. The registration is what tells the drain an event is a
 * connector delivery: it becomes a `connector:<provider>` platform intent, and the platform,
 * which holds the credential, dispatches it back through `/internal/connector-call`. The
 * same pattern as `declareScriveConnector` (`connectors/scrive`).
 */
export function declareConnectorEvents(
  host: Pick<ScopeHost, 'registerConnector'>,
  connectors: VerticalConnectors,
  options: { retry?: ConnectorOptions } = {},
): void {
  for (const provider of connectors.providers) {
    for (const eventType of connectors.definition(provider)?.events ?? []) {
      host.registerConnector(
        `${provider}:${eventType}`,
        eventType,
        async () => {
          throw new Error(`${provider}: this host registered the connector for routing only — the platform dispatches it`);
        },
        { ...options.retry, provider },
      );
    }
  }
}

export interface ConnectorCallDeps {
  connectors: VerticalConnectors;
  host: Pick<VerticalScopeHost, 'connectorInvokeLocal' | 'connectorAttachmentUploadLocal' | 'connectorAttachmentOpenLocal'>;
  /** The runtime's fetch (`globalFetch`), which the context bounds and records. */
  fetch: FetchLike;
  /** Per outbound request. Default 30 s, a connector call's usual bound. */
  timeoutMs?: number;
  /** The roles this route serves, and the path named when another is refused. Default: all. */
  allowed?: { roles: readonly ConnectorCallRole[]; path: string };
}

const ERROR_MAX = 600;

function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof (e as { message?: unknown })?.message === 'string' ? (e as { message: string }).message : String(e);
  return raw.slice(0, ERROR_MAX) || 'the connector call failed';
}

/**
 * Serve one platform call into a vertical-defined connector (§6.3). Never throws: every failure
 * is an `ok: false` answer, and only a success carries state writes.
 */
export async function runConnectorCall(request: unknown, deps: ConnectorCallDeps): Promise<ConnectorCallResponse> {
  const parsed = connectorCallRequest.safeParse(request);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, refused: true, error: errorText(`not a connector call: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim()), uses: [] };
  }
  const req = parsed.data;
  if (deps.allowed && !deps.allowed.roles.includes(req.role)) {
    return { ok: false, refused: true, error: `${req.role} is not served on ${deps.allowed.path}`, uses: [] };
  }
  const def = deps.connectors.definition(req.provider);
  if (!def) return { ok: false, refused: true, error: `this version declares no connector ${req.provider}`, uses: [] };

  const uses: ConnectionUseOutcomeWire[] = [];
  const record = (u: ConnectionUseOutcomeWire): void => {
    uses.push(u.ok ? u : { ...u, error: u.error.slice(0, ERROR_MAX) });
    if (uses.length > CONNECTOR_CALL_MAX_USES) uses.shift();
  };
  const bounded = deadlineFetch(deps.fetch, deps.timeoutMs ?? 30_000);
  const fetch: FetchLike = async (input, init) => {
    const started = Date.now();
    try {
      const response = await bounded(input, init);
      record(settleConnectionUse(req.provider, Math.max(0, Date.now() - started), { response }));
      return response;
    } catch (error) {
      record(settleConnectionUse(req.provider, Math.max(0, Date.now() - started), { error }));
      throw error;
    }
  };

  const store = new Map<string, unknown>('state' in req ? req.state.map((e) => [e.key, e.value]) : []);
  const writes = new Map<string, unknown>();

  try {
    const result = await runRole(req, def, deps, fetch, store, writes);
    const answer = connectorCallResponse.safeParse({
      ok: true,
      result,
      state: [...writes].map(([key, value]) => ({ key, value })),
      uses,
    });
    if (answer.success) return answer.data;
    return { ok: false, refused: false, error: errorText(`connector state writes exceed the call's limits: ${answer.error.issues[0]?.message ?? ''}`), uses };
  } catch (e) {
    return { ok: false, refused: isConnectorRefusal(e), error: errorText(e), uses };
  }
}

async function runRole(
  req: ConnectorCallRequest,
  def: ConnectorDefinition,
  deps: ConnectorCallDeps,
  fetch: FetchLike,
  store: Map<string, unknown>,
  writes: Map<string, unknown>,
): Promise<unknown> {
  if (req.role === 'probe-candidate') return probeAnswer(await def.probeCandidate(req.secret, { fetch }));

  const { secret, ...connection } = req.connection;
  const base: ConnectionContext = {
    connection,
    secret,
    fetch,
    state: {
      get: async (key) => store.get(key),
      put: async (key, value) => {
        if (value === null || value === undefined) {
          store.delete(key);
          writes.set(key, null);
        } else {
          store.set(key, value);
          writes.set(key, value);
        }
      },
      list: async (prefix = '') => [...store].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })),
    },
  };
  if (req.role === 'probe') return probeAnswer(await def.probe(base));

  const scopeId = req.role === 'sweep' ? req.binding.scopeId : req.scopeId;
  const binding = req.role === 'bind' ? null : req.binding;
  const eventId = req.role === 'dispatch' ? req.event.id : undefined;
  const { id, tenantId } = connection;
  const invoke = async <O>(operation: string, input?: unknown): Promise<O> =>
    (await deps.host.connectorInvokeLocal(id, tenantId, scopeId, operation, externalInput(input))) as O;
  const operation = binding?.operation ?? null;
  const ctx: ScopedConnectionContext = {
    ...base,
    scope: { tenantId, scopeId, operation, options: binding?.options ?? (req.role === 'bind' ? req.options : {}) },
    land: async <O>(input: unknown) => {
      if (operation === null) throw new ConnectorRefusal(`${req.provider}: scope ${scopeId} has no binding, so there is no landing operation`);
      return invoke<O>(operation, input);
    },
    invoke,
    attachments: {
      upload: async (input) => attachmentRecord.parse(await deps.host.connectorAttachmentUploadLocal(id, tenantId, scopeId, input)),
      open: async (attachmentId): Promise<OpenedAttachment | null> => {
        const opened = await deps.host.connectorAttachmentOpenLocal(id, tenantId, scopeId, attachmentId, eventId);
        return opened && { ...opened, record: attachmentRecord.parse(opened.record) };
      },
    },
  };

  switch (req.role) {
    case 'bind':
      if (def.bind) return connectorBindResult.parse({ options: await def.bind(ctx, req.options) });
      if (Object.keys(req.options).length > 0) throw new ConnectorRefusal(`${req.provider}: this connector takes no binding options`);
      return { options: {} };
    case 'sweep': {
      if (!def.sweep) throw new ConnectorRefusal(`${req.provider}: this connector defines no sweep`);
      const r = await def.sweep(ctx);
      return connectorSweepResult.parse({ landed: r?.landed ?? 0, more: r?.more ?? false });
    }
    case 'dispatch':
      if (!def.dispatch) throw new ConnectorRefusal(`${req.provider}: this connector defines no dispatch`);
      await def.dispatch(ctx, req.event);
      return null;
  }
}
