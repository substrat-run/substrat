import { z } from 'zod';
import { instant, tenantId } from './ids.js';

/**
 * The integrations hub's connection store (#101, design/connections.md §3).
 *
 * A connection is one tenant's authorization to act against one external
 * provider, held by one vertical. Everything here is METADATA — the credential
 * itself never appears in this file, and never crosses a read path that returns
 * these shapes.
 */

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const connectionId = z.string().regex(ULID).brand<'ConnectionId'>();
export type ConnectionId = z.infer<typeof connectionId>;

/** Vertical vocabulary, like `scope.vertical`: 'scrive', 'fortnox', 'visma'. */
export const connectionProvider = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'provider is a lowercase slug');

export const connectionStatus = z.enum([
  /** Usable. */
  'active',
  /** The provider's grant lapsed — refresh failed or the window closed. */
  'expired',
  /** Withdrawn deliberately. Terminal; a replacement is a new connection. */
  'revoked',
  /** Last use failed. Still holds a credential, so distinct from `expired`. */
  'error',
]);
export type ConnectionStatus = z.infer<typeof connectionStatus>;

/**
 * A connection as the directory holds it.
 *
 * Keyed on **(tenant, vertical, provider, account)** rather than tenant alone
 * (connections.md §3.1.1): a vertical is a blast-radius boundary (D-30) and
 * verticals are built by different companies (D-33), so one vendor's host code
 * must not reach a credential another vendor connected. It also matches how
 * OAuth issues clients — two vendors acting for one tenant hold two clients.
 * The account leg is `externalAccountRef` (Vercel's "Git namespace" shape): one
 * tenant may hold the SAME provider under several external accounts — two
 * GitHub orgs, say — and each is its own connection. Providers that never set
 * an account ref collapse back to one live connection per (tenant, vertical,
 * provider), the pre-#101-widening behavior.
 */
export const connection = z.object({
  id: connectionId,
  tenantId,
  /** The owning vertical's slug — the deployment allowed to use this. */
  vertical: z.string().min(1),
  provider: connectionProvider,
  /** Human label for a console: 'Nordljus Scrive (prod)'. */
  label: z.string().min(1),
  status: connectionStatus,
  /**
   * The provider's own identifier for the account, when it has one — a Scrive
   * company id, a Fortnox tenant. Opaque, and NOT a credential: it is what makes
   * "which account is this?" answerable without opening the secret.
   */
  externalAccountRef: z.string().nullable(),
  /** Provider scopes/permissions the grant carries, as the provider names them. */
  scopes: z.array(z.string()),
  /** When the grant itself lapses (OAuth refresh-token lifetime), if known. */
  expiresAt: instant.nullable(),
  /** Health (§3.7) — written by the runtime, read by a console. */
  lastOkAt: instant.nullable(),
  lastError: z.string().nullable(),
  lastErrorAt: instant.nullable(),
  createdBy: z.string().min(1),
  createdAt: instant,
  revokedAt: instant.nullable(),
});
export type Connection = z.infer<typeof connection>;

/**
 * The credential, as the caller supplies it.
 *
 * Deliberately an opaque string map rather than a typed OAuth shape: an API-token
 * provider carries `{ token }`, OAuth2 carries `{ accessToken, refreshToken }`,
 * and mTLS carries something else again. The hub seals the whole map and never
 * interprets it — interpreting it is the connector's job, and a typed union here
 * would make the kernel learn each provider, which is precisely the coupling
 * D-18's triage rule keeps out.
 */
export const connectionSecret = z.record(z.string().min(1), z.string());
export type ConnectionSecret = z.infer<typeof connectionSecret>;

export const createConnectionInput = z.object({
  id: connectionId,
  tenantId,
  vertical: z.string().min(1),
  provider: connectionProvider,
  label: z.string().min(1),
  externalAccountRef: z.string().optional(),
  scopes: z.array(z.string()).default([]),
  expiresAt: instant.optional(),
  secret: connectionSecret,
  /**
   * Who authorized this connection, when that is a tenant principal rather than the
   * effecting platform actor (connections.md §3.5.1). A self-serve connect is a tenant
   * admin's in-scope, permission-checked act; the host effects the sealed write with
   * platform authority, but the connection must record the *principal* who authorized
   * it — not `STAFF`, which would launder the act (the D-31 defect). Omitted ⇒ the
   * caller's `actor`, so existing platform-driven callers are unchanged.
   */
  createdBy: z.string().min(1).optional(),
});
export type CreateConnectionInput = z.input<typeof createConnectionInput>;

export const connectionFilter = z.object({
  tenantId: tenantId.optional(),
  vertical: z.string().min(1).optional(),
  provider: connectionProvider.optional(),
  /** Narrow to one external account — the multi-namespace provider's selector. */
  externalAccountRef: z.string().optional(),
  /** Revoked connections are evidence, not roster — excluded unless asked for. */
  includeRevoked: z.boolean().optional(),
});
export type ConnectionFilter = z.infer<typeof connectionFilter>;

/**
 * A connection with its credential opened — what a connector receives, and the
 * only shape in the system that carries plaintext.
 *
 * Never returned by an audited `HostAdmin` read, never logged, never serialized
 * into an event. It exists for the duration of one connector call.
 */
export interface OpenConnection {
  id: ConnectionId;
  tenantId: string;
  vertical: string;
  provider: string;
  secret: ConnectionSecret;
  expiresAt: string | null;
}
