import { z } from 'zod';
import { instant, permissionKey, scopeId, tenantId } from './ids.js';
import { connectionId, connectionProvider } from './connections.js';
import { connectionLandingOptions } from './connection-landing.js';
import { domainEvent, eventType } from './events.js';

/**
 * Vertical-defined connectors (docs/architecture/vertical-connectors.md): the vocabulary a
 * vertical's connector declaration, the platform's call into the vertical's worker, and the
 * vertical's answer share.
 *
 * The platform keeps every piece of state and authority it holds for a first-party connector —
 * the sealed credential, the bindings, the connector state — and hands the vertical's code one
 * connection's worth of it per call (§6). Everything that crosses that call is parsed by these
 * schemas on both ends.
 */

/** A dot marks a vertical-defined provider (§4); first-party slugs never contain one. */
export function isVerticalConnectorProvider(provider: string): boolean {
  return provider.includes('.');
}

export const verticalConnectorProvider = connectionProvider.refine(
  isVerticalConnectorProvider,
  'a vertical-defined provider is <namespace>.<name>',
);

/**
 * One field of the credential form the dashboard renders for a vertical-defined provider — the
 * dashboard's own `ProviderField`, minus `toggle`. Every field is stored sealed regardless of
 * `secret`, which only decides whether the UI echoes it back.
 */
export const verticalConnectorField = z
  .object({
    key: z.string().max(64).regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'a field key is an identifier'),
    label: z.string().min(1).max(80),
    secret: z.boolean(),
    placeholder: z.string().max(120).optional(),
    optional: z.literal(true).optional(),
  })
  .strict();
export type VerticalConnectorField = z.infer<typeof verticalConnectorField>;

/**
 * The static half of one `defineConnectors` entry (§5.1), as the push manifest carries it.
 *
 * `sweeps`, `binds` and `dispatches` say which optional hooks the code supplies. The probes are
 * mandatory, so they carry no flag. `dispatches` is true exactly when `events` routes something:
 * a routed event with no handler would fail every delivery, and a handler nothing routes to is
 * dead code the declaration should not advertise.
 */
export const verticalConnectorDeclaration = z
  .object({
    provider: verticalConnectorProvider,
    label: z.string().min(1).max(80),
    description: z.string().max(400),
    monogram: z.string().min(1).max(3).optional(),
    fields: z
      .array(verticalConnectorField)
      .min(1)
      .max(12)
      .refine((fs) => new Set(fs.map((f) => f.key)).size === fs.length, { message: 'field keys must be unique' }),
    /** The connection's standing grants. Required, so a declaration states "none" as `[]`. */
    grants: z.array(permissionKey).max(16),
    /** The event types routed to `dispatch()`. Required for the same reason. */
    events: z
      .array(eventType)
      .max(8)
      .refine((es) => new Set(es).size === es.length, { message: 'routed event types must be unique' }),
    sweeps: z.boolean(),
    binds: z.boolean(),
    dispatches: z.boolean(),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.dispatches !== d.events.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['dispatches'],
        message: d.dispatches ? 'dispatches is true but no event is routed to it' : 'events are routed but dispatches is false',
      });
    }
  });
export type VerticalConnectorDeclaration = z.infer<typeof verticalConnectorDeclaration>;

export const verticalConnectorDeclarations = z
  .array(verticalConnectorDeclaration)
  .max(8)
  .superRefine((ds, ctx) => {
    const seen = new Set<string>();
    for (const [i, d] of ds.entries()) {
      if (seen.has(d.provider)) ctx.addIssue({ code: 'custom', path: [i, 'provider'], message: `provider ${d.provider} is declared more than once` });
      seen.add(d.provider);
    }
  });

/** The platform-surface route the platform calls a vertical's connector through (§6.3). */
export const CONNECTOR_CALL_PATH = '/internal/connector-call';
/** The route the connection-level roles (`probe`, `probe-candidate`) take: no scope, no nonce (§6.3). */
export const CONNECTOR_PROBE_PATH = '/internal/connector-probe';
/** State per call, serialised, in and out (§6.2). */
export const CONNECTOR_CALL_STATE_MAX_BYTES = 512 * 1024;
/** State keys per call, in and out (§6.2). */
export const CONNECTOR_CALL_STATE_MAX_KEYS = 2000;
/** Recorded uses one call may report. */
export const CONNECTOR_CALL_MAX_USES = 100;

/** The connector-state key the platform keeps a scope's binding under (§6.1). */
export const VERTICAL_CONNECTOR_BINDING_PREFIX = 'vc:binding:';
/** The connector-state prefix the vertical's own state lives under (§6.2). */
export const VERTICAL_CONNECTOR_STATE_PREFIX = 'vc:state:';

export function verticalConnectorBindingKey(scopeId: string): string {
  return `${VERTICAL_CONNECTOR_BINDING_PREFIX}${scopeId}`;
}

/** `vc:state:-:` for connection-level state, `vc:state:<scopeId>:` for one scope's. */
export function verticalConnectorStatePrefix(scopeId: string | null): string {
  return `${VERTICAL_CONNECTOR_STATE_PREFIX}${scopeId ?? '-'}:`;
}

export function verticalConnectorStateKey(scopeId: string | null, key: string): string {
  return `${verticalConnectorStatePrefix(scopeId)}${key}`;
}

const stateEntries = (what: string) =>
  z
    .array(z.object({ key: z.string().min(1).max(200), value: z.unknown() }).strict())
    .max(CONNECTOR_CALL_STATE_MAX_KEYS, { message: `${what} carries at most ${CONNECTOR_CALL_STATE_MAX_KEYS} keys` })
    .superRefine((entries, ctx) => {
      if (new Set(entries.map((e) => e.key)).size !== entries.length) ctx.addIssue({ code: 'custom', message: `${what} names a key twice` });
      const bytes = new TextEncoder().encode(JSON.stringify(entries)).byteLength;
      if (bytes > CONNECTOR_CALL_STATE_MAX_BYTES) {
        ctx.addIssue({ code: 'custom', message: `${what} is ${bytes} bytes serialised; at most ${CONNECTOR_CALL_STATE_MAX_BYTES}` });
      }
    });

/** The connector's state as a call carries it in: the keys, without their storage prefix. */
export const connectorCallState = stateEntries('connector state');
export type ConnectorCallState = z.infer<typeof connectorCallState>;

/** The connector's state writes as a call carries them out. A `null` value deletes the key. */
export const connectorCallStateWrites = stateEntries('connector state writes');
export type ConnectorCallStateWrites = z.infer<typeof connectorCallStateWrites>;

const useTiming = {
  durationMs: z.number().nonnegative().optional(),
  status: z.number().int().optional(),
  timedOut: z.boolean().optional(),
};

/** One recorded use of the connection — the kernel's `ConnectionUseOutcome`, on the wire. */
export const connectionUseOutcome = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), ...useTiming }).strict(),
  z.object({ ok: z.literal(false), error: z.string().max(600), ...useTiming }).strict(),
]);
export type ConnectionUseOutcomeWire = z.infer<typeof connectionUseOutcome>;

/** A binding the platform holds for a vertical-defined connection (§6.1), at `vc:binding:<scopeId>`. */
export const verticalConnectorBinding = z
  .object({
    scopeId,
    operation: z.string().regex(/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/, 'operation is `module/operation`'),
    permission: permissionKey,
    /** The options the connector sees: what its `bind` hook normalised them to. */
    options: connectionLandingOptions,
    /**
     * The options as the landing or the binding door supplied them, before `bind` normalised
     * them. What a declaration is compared with, so a hook that rewrites an option (a folder path
     * to its id) does not read as a changed declaration and re-bind on every pass.
     */
    declared: connectionLandingOptions,
    boundAt: instant,
  })
  .strict();
export type VerticalConnectorBinding = z.infer<typeof verticalConnectorBinding>;

/** The connection a call is made for, with its opened credential. Never anything else's. */
export const connectorCallConnection = z
  .object({
    id: connectionId,
    tenantId,
    vertical: z.string().min(1),
    provider: verticalConnectorProvider,
    externalAccountRef: z.string().nullable(),
    expiresAt: instant.nullable(),
    secret: z.record(z.string(), z.string()),
  })
  .strict();
export type ConnectorCallConnection = z.infer<typeof connectorCallConnection>;

/** The platform's call into a vertical's worker (§6.3), one per role. */
export const connectorCallRequest = z
  .discriminatedUnion('role', [
    z
      .object({ role: z.literal('probe-candidate'), provider: verticalConnectorProvider, secret: z.record(z.string(), z.string()) })
      .strict(),
    z
      .object({ role: z.literal('probe'), provider: verticalConnectorProvider, connection: connectorCallConnection, state: connectorCallState })
      .strict(),
    z
      .object({
        role: z.literal('bind'),
        provider: verticalConnectorProvider,
        connection: connectorCallConnection,
        scopeId,
        options: z.record(z.string(), z.unknown()),
      })
      .strict(),
    z
      .object({
        role: z.literal('sweep'),
        provider: verticalConnectorProvider,
        connection: connectorCallConnection,
        binding: verticalConnectorBinding,
        state: connectorCallState,
      })
      .strict(),
    z
      .object({
        role: z.literal('dispatch'),
        provider: verticalConnectorProvider,
        connection: connectorCallConnection,
        scopeId,
        binding: verticalConnectorBinding.nullable(),
        event: domainEvent,
        state: connectorCallState,
      })
      .strict(),
  ])
  .superRefine((req, ctx) => {
    if ('connection' in req && req.connection.provider !== req.provider) {
      ctx.addIssue({ code: 'custom', path: ['connection', 'provider'], message: `the connection is for ${req.connection.provider}, not ${req.provider}` });
    }
  });
export type ConnectorCallRequest = z.infer<typeof connectorCallRequest>;

const uses = z.array(connectionUseOutcome).max(CONNECTOR_CALL_MAX_USES);

/**
 * The vertical's answer. On `ok: false` no state write is applied; `refused` says the connector
 * threw `ConnectorRefusal` (terminal) rather than failing in a way worth retrying.
 */
export const connectorCallResponse = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.unknown(), state: connectorCallStateWrites, uses }).strict(),
  z.object({ ok: z.literal(false), refused: z.boolean(), error: z.string().min(1).max(600), uses }).strict(),
]);
export type ConnectorCallResponse = z.infer<typeof connectorCallResponse>;

/** `result` of a `sweep` call. A `probe` or `probe-candidate` call answers `connectionProbe`. */
export const connectorSweepResult = z.object({ landed: z.number().int().nonnegative(), more: z.boolean() });
export type ConnectorSweepResult = z.infer<typeof connectorSweepResult>;

/** `result` of a `bind` call: the options normalised, which the platform stores on the binding. */
export const connectorBindResult = z.object({ options: z.record(z.string(), z.unknown()) });
export type ConnectorBindResult = z.infer<typeof connectorBindResult>;
