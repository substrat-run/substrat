import { z } from 'zod';
import {
  entityRef,
  scopeId as scopeIdSchema,
  tenantId as tenantIdSchema,
  type ConnectionId,
  type ScopeId,
} from '@substrat-run/contracts';
import type { ConnectorHandler, ConnectorOptions, HostAdmin, ScopeHost } from '@substrat-run/kernel';
import { BolagsverketApi } from './api.js';
import { bolagsverketCredential, type BolagsverketConfig } from './config.js';
import { BOLAGSVERKET_PROVIDER } from './connector.js';
import { BolagsverketError } from './errors.js';
import { organisationValidation } from './organisation.js';
import { parseOrgnr } from './orgnr.js';

/**
 * The lookup a vertical asks for (#2855): look an organisation number up in Bolagsverket's
 * register, and land the answer in the scope that asked.
 *
 * The shape is the platform's usual one for a connector with a return path, put together from
 * pieces that already exist:
 *
 * - **The vertical asks by emitting** {@link BOLAGSVERKET_LOOKUP_REQUESTED} from one of its own
 *   operations, and registers the event for routing with {@link declareBolagsverketConnector}.
 *   On a hosted scope the delivery becomes a `connector:bolagsverket` intent, and the router's
 *   drain kick has the control plane dispatch it within seconds.
 * - **The vertical says where the answer lands** with a connection landing in its module
 *   manifest: `connections: [{ provider: 'bolagsverket', operation, permission }]` (#2316). The
 *   platform's connector pass grants the key to each live Bolagsverket connection and binds it to
 *   every primary, active install, through {@link bindBolagsverketScope}.
 * - **The dispatch lands its own answer.** Bolagsverket has nothing to poll afterwards, and the
 *   sweep runs on a 15-minute cron, so the dispatch invokes the bound operation itself, as the
 *   connection, with a {@link bolagsverketLookupLanding}. A person pressing a button sees the
 *   answer in seconds, not at the next pass.
 *
 * Delivery is at least once: a redelivered request looks the number up again and lands again with
 * the same `requestId`. A lookup is a read, so the only thing that must be idempotent is the
 * landing operation, which upserts on `requestId`.
 */
export const BOLAGSVERKET_LOOKUP_REQUESTED = 'bolagsverket.organisation-lookup-requested';

/**
 * The request's payload. `requestId` is the vertical's own and comes back on the landing, so the
 * landing operation knows which request it answers; `subject` is the record the number belongs
 * to (a customer, say), echoed back unchanged.
 *
 * Validate the number with {@link parseOrgnr} before emitting. A personnummer is refused by this
 * connector and never sent, but the request event that carried it is already in the scope's
 * outbox by then.
 */
export const bolagsverketLookupRequested = z.object({
  requestId: z.string().min(1).max(200),
  organisationNumber: z.string().min(1).max(40),
  subject: entityRef.nullable().optional(),
});
export type BolagsverketLookupRequested = z.infer<typeof bolagsverketLookupRequested>;

/**
 * What the bound operation receives.
 *
 * - `found` / `not_found` — the register's answer, in `result`. Not found is an answer, not a
 *   failure.
 * - `invalid` — refused locally before any request; `reason` is `format`, `checksum` or
 *   `personnummer`. The number is not echoed back.
 * - `refused` — Bolagsverket turned the tenant's client away (a 401 after one re-mint, or a 403);
 *   `reason` is its message. The dispatch fails as well, so the refusal is on the platform's
 *   failure record and the connection's health, not only in the scope.
 *
 * A rate limit or an outage lands nothing: the dispatch is retried, and lands when it succeeds.
 */
export const BOLAGSVERKET_LOOKUP_OUTCOMES = ['found', 'not_found', 'invalid', 'refused'] as const;

export const bolagsverketLookupLanding = z.object({
  requestId: z.string().min(1),
  subject: entityRef.nullable(),
  connectionId: z.string().min(1),
  outcome: z.enum(BOLAGSVERKET_LOOKUP_OUTCOMES),
  result: organisationValidation.nullable(),
  reason: z.string().max(600).nullable(),
  checkedAt: z.string(),
});
export type BolagsverketLookupLanding = z.infer<typeof bolagsverketLookupLanding>;

/** A connection's landing in one scope: the operation a result is invoked through, and its key. */
export interface BolagsverketBinding {
  scopeId: string;
  tenantId: string;
  vertical: string;
  operation: string;
  permission: string;
  boundAt: string;
}

const BINDING_PREFIX = 'bolagsverket:binding:';
const bindingKey = (scope: string): string => `${BINDING_PREFIX}${scope}`;

const isBinding = (v: unknown): v is BolagsverketBinding =>
  v !== null && typeof v === 'object' && typeof (v as BolagsverketBinding).operation === 'string';

/**
 * Land this connection's lookups in one scope, through `operation`.
 *
 * Refuses a connection that does not hold `permission` in the scope, unless the automatic landing
 * pass has checked the declaration and writes the grant straight after (`grantPreflighted`): a
 * binding the connection cannot invoke through would fail every lookup after the provider answered.
 */
export async function bindBolagsverketScope(
  host: ScopeHost,
  input: {
    connectionId: ConnectionId;
    tenantId: string;
    scopeId: string;
    vertical: string;
    operation: string;
    permission: string;
    grantPreflighted?: boolean;
    now?: () => number;
  },
): Promise<BolagsverketBinding> {
  const tenant = tenantIdSchema.parse(input.tenantId);
  const scope = scopeIdSchema.parse(input.scopeId);
  if (!input.grantPreflighted) {
    const granted = await host.connectionGrantsInScope(tenant, scope);
    if (!granted.some((g) => g.connectionId === input.connectionId && g.permission === input.permission)) {
      throw new Error(
        `connection ${input.connectionId} does not hold '${input.permission}' on scope ${input.scopeId}, so a ` +
          `lookup would reach Bolagsverket and then fail to land. Grant it first (grantToConnection), then bind.`,
      );
    }
  }
  const binding: BolagsverketBinding = {
    scopeId: input.scopeId,
    tenantId: input.tenantId,
    vertical: input.vertical,
    operation: input.operation,
    permission: input.permission,
    boundAt: new Date(input.now?.() ?? Date.now()).toISOString(),
  };
  await host.admin.putConnectorState(input.connectionId, bindingKey(input.scopeId), binding);
  return binding;
}

/** Every scope this connection lands lookups in. Tombstones are left out. */
export async function listBolagsverketBindings(host: ScopeHost, connectionId: ConnectionId): Promise<BolagsverketBinding[]> {
  const rows = await host.admin.listConnectorState(connectionId, BINDING_PREFIX);
  return rows.map((r) => r.value).filter(isBinding);
}

/** Stop landing lookups in one scope. A tombstone, since `putConnectorState` is the only write verb. */
export async function unbindBolagsverketScope(host: ScopeHost, connectionId: ConnectionId, scopeId: string): Promise<void> {
  await host.admin.putConnectorState(connectionId, bindingKey(scopeId), null);
}

async function readBinding(admin: HostAdmin, connectionId: ConnectionId, scopeId: string): Promise<BolagsverketBinding | null> {
  const stored = await admin.getConnectorState(connectionId, bindingKey(scopeId));
  return isBinding(stored) ? stored : null;
}

/**
 * Register the lookup for ROUTING ONLY, on a host that never runs it: a hosted vertical's scope,
 * which holds no credential. The registration is what tells the scope's drain that a
 * {@link BOLAGSVERKET_LOOKUP_REQUESTED} event is a connector delivery, so it becomes a
 * `connector:bolagsverket` intent for the platform to dispatch. The same pattern as
 * `declareScriveConnector`.
 */
export function declareBolagsverketConnector(
  host: Pick<ScopeHost, 'registerConnector'>,
  options: { retry?: ConnectorOptions } = {},
): void {
  host.registerConnector(
    `${BOLAGSVERKET_PROVIDER}.${BOLAGSVERKET_LOOKUP_REQUESTED}`,
    BOLAGSVERKET_LOOKUP_REQUESTED,
    async () => {
      throw new Error('bolagsverket: this host registered the connector for routing only — the platform dispatches it');
    },
    { ...options.retry, provider: BOLAGSVERKET_PROVIDER },
  );
}

export interface BolagsverketDispatchOptions extends BolagsverketConfig {
  /**
   * The scope a result lands in, opened as the connection: `host.getConnectorScope` on the
   * platform. Passed in rather than reached for, because a dispatch's own context holds no scope.
   */
  scope: (connectionId: ConnectionId, scopeId: ScopeId) => Promise<{ invoke(operation: string, input?: unknown): Promise<unknown> }>;
  now?: () => number;
}

/**
 * The dispatch half: look the requested number up with the tenant's connection, and land the
 * answer through the scope's binding. Throws, and the drain retries, when there is no live
 * connection, no binding or no landing grant yet, on a rate limit and on an outage; a refused client lands
 * `refused` and then throws, which the drain settles as failed.
 */
export function bolagsverketConnector(options: BolagsverketDispatchOptions): ConnectorHandler {
  const now = options.now ?? (() => Date.now());
  return async (ctx, event) => {
    if (event.type !== BOLAGSVERKET_LOOKUP_REQUESTED) return;
    const request = bolagsverketLookupRequested.parse(event.payload);
    const conn = await ctx.connection(BOLAGSVERKET_PROVIDER);
    const binding = await readBinding(ctx.admin, conn.id, ctx.scopeId);
    if (!binding) {
      throw new Error(
        `no Bolagsverket landing is bound to scope ${ctx.scopeId} on connection ${conn.id}. The vertical declares ` +
          `connections: [{ provider: 'bolagsverket', operation, permission }] in its module, and the next ` +
          `connector pass grants and binds it.`,
      );
    }
    // The landing pass writes a binding BEFORE its grant (`bindBeforeGrant`), and a failed grant
    // leaves the binding stored. An invoke without the key is a 403, which the drain settles as
    // terminal, so a request caught in that gap would fail for good. Wait for the grant instead:
    // a plain error is retried, and the next pass delivers the key.
    if (!(await conn.grants()).includes(binding.permission as never)) {
      throw new Error(
        `connection ${conn.id} does not hold '${binding.permission}' on scope ${ctx.scopeId} yet, so the answer ` +
          `could not land; retried once the connector pass delivers the grant`,
      );
    }
    const base = {
      requestId: request.requestId,
      subject: request.subject ?? null,
      connectionId: conn.id,
      checkedAt: new Date(now()).toISOString(),
    };
    const land = async (landing: Omit<BolagsverketLookupLanding, keyof typeof base>): Promise<void> => {
      const scope = await options.scope(conn.id, ctx.scopeId);
      await scope.invoke(binding.operation, bolagsverketLookupLanding.parse({ ...base, ...landing }));
    };

    const parsed = parseOrgnr(request.organisationNumber);
    if (!parsed.ok) {
      await land({ outcome: 'invalid', result: null, reason: parsed.reason });
      return;
    }
    // No 429 waits inside a dispatch: the drain's own retry is the back-off, and it does not
    // hold a drain pass open for a minute.
    const api = new BolagsverketApi(bolagsverketCredential.parse(conn.secret), conn.fetch, {
      ...options,
      now,
      maxRateLimitRetries: 0,
    });
    let result;
    try {
      result = await api.validateOrganisation(parsed.orgnr);
    } catch (err) {
      if (err instanceof BolagsverketError && err.refused) {
        await land({ outcome: 'refused', result: null, reason: err.message.slice(0, 600) });
      }
      throw err;
    }
    await land({ outcome: result.exists ? 'found' : 'not_found', result, reason: null });
  };
}
