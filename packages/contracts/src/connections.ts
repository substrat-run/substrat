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

/**
 * One provider-named fact about a connection — the readable half of a probe or an
 * activity row. A pair, not a typed union, deliberately: the platform must be able to
 * show 'Company: Nordljus AB' or 'BankID to sign: disabled' without learning what
 * either means. The provider decides what is worth saying; the console renders it.
 */
export const connectionFact = z.object({
  label: z.string().min(1).max(80),
  value: z.string().max(400),
});
export type ConnectionFact = z.infer<typeof connectionFact>;

/**
 * What a **probe** answers (#605): did this credential just work, and whose account is
 * it? A connection's health (§3.7) is written by whatever call happened last, which
 * means a freshly connected credential has no health at all until the first real
 * dispatch — possibly days later, and possibly a legal document sent to real
 * signatories. A probe is the cheap read that turns "stored" into "verified" on the
 * spot, and it rides the sanctioned `fetch`, so it refreshes health as a side effect.
 *
 * Provider-agnostic on purpose: `control-plane-api` holds no connector and learns no
 * provider's vocabulary. A connector supplies the probe; this is the shape it must
 * answer in.
 */
export const connectionProbe = z.object({
  /** True when the provider accepted the credential. False is a real answer, not an error. */
  ok: z.boolean(),
  /**
   * When `ok` is false: did the PROVIDER refuse the credential (a definite answer — an
   * HTTP 401/403), or could the probe simply not tell (timeout, 5xx, DNS)?
   *
   * The distinction decides whether a caller may act on the failure. A refusal is grounds
   * to reject a connect attempt outright; an unreachable provider is not — rejecting then
   * would make a Scrive outage look like every tenant's credentials going bad, and would
   * block a rotation that needs to happen precisely because things are broken.
   *
   * Defaulted false so an older producer's answer reads as "inconclusive", which is the
   * side that never blocks.
   */
  refused: z.boolean().default(false),
  /**
   * The provider's own identifier for the account the credential acts as — a Scrive
   * company id, a Fortnox tenant. The same value `externalAccountRef` holds, which is
   * what makes a probe able to say "these keys are for a DIFFERENT account than the one
   * this connection was created for".
   */
  accountRef: z.string().max(200).nullable(),
  /** Human label for that account: 'Nordljus AB (drift@nordljus.se)'. */
  accountLabel: z.string().max(200).nullable(),
  /** Anything else worth showing an operator — plan, role, whether a feature is enabled. */
  facts: z.array(connectionFact).max(16).default([]),
  /**
   * The provider's own error message when `ok` is false — 'This feature is disabled'
   * reads differently from 'invalid credentials', and that difference is the whole
   * value of a probe. Never carries credential material: a probe reports what the
   * provider said, never what was sent.
   */
  error: z.string().max(600).nullable(),
});
export type ConnectionProbe = z.infer<typeof connectionProbe>;

/**
 * One thing a connection **did** (#605) — a projection of the connector's own dispatch
 * ledger (`listConnectorState`), which is the only durable record that an outbound call
 * ever happened. The audit log deliberately holds none of this (`openConnection` is
 * unaudited: one row per outbound HTTP call would drown the log that matters), and
 * health keeps exactly one line, last-write-wins.
 *
 * **Projected by the connector, never read raw.** A ledger row is opaque connector
 * bookkeeping and may hold secrets — Scrive's rows carry the callback capability token —
 * so the platform never serves them as-is. The provider maps its own rows into this
 * declared shape, which is how redaction becomes structural rather than remembered.
 */
export const connectionActivityEntry = z.object({
  /** The ledger key — stable, opaque, and the handle a per-row refresh would use. */
  key: z.string().min(1),
  /** What this was: a document title, an invoice number. */
  title: z.string().min(1).max(200),
  /** The provider's own id for the thing, when it has one. */
  reference: z.string().max(200).nullable(),
  /** Provider-named state, already humanized: 'awaiting signatures', 'signed'. */
  status: z.string().min(1).max(80),
  /** When it started, as the connector recorded it. */
  at: instant.nullable(),
  /** The readable detail — parties and what each has done, the frozen hash, and so on. */
  facts: z.array(connectionFact).max(32).default([]),
});
export type ConnectionActivityEntry = z.infer<typeof connectionActivityEntry>;

/**
 * Where a set of activity entries came from (#605). Two genuinely different questions,
 * and a console that answers one while the operator asked the other is worse than one
 * that answers neither:
 *
 * - `ledger` — what THIS platform sent through this connection. Complete for our own
 *   traffic, blind to everything else in the provider account.
 * - `provider` — what the provider currently holds, listed from its own API. Includes
 *   documents nobody here created (someone using Scrive's own UI), and is bounded by
 *   whatever page the connector asked for.
 */
export const connectionActivitySource = z.enum(['ledger', 'provider']);
export type ConnectionActivitySource = z.infer<typeof connectionActivitySource>;

export const connectionActivity = z.object({
  source: connectionActivitySource.default('ledger'),
  entries: z.array(connectionActivityEntry),
  /**
   * True when the entries carry the provider's CURRENT state (a live read happened),
   * false when they are the ledger's own view. The distinction is not cosmetic: the
   * ledger knows what the platform recorded, not what the provider has since done, and
   * a console that blurs the two invents facts.
   */
  live: z.boolean(),
});
export type ConnectionActivity = z.infer<typeof connectionActivity>;

/**
 * One stored credential field, as a console may see it (#605).
 *
 * The store's rule is that a credential goes in and never comes out: `Connection` cannot
 * carry a secret (contract-tested), and no route returns `connectionSecret`. That rule
 * stands. What it left, though, was a screen where "connected" and "connected with the
 * wrong keys" looked identical, and the only repair offered was to paste all four fields
 * again blind.
 *
 * So this is a deliberate, bounded disclosure with two rules:
 *
 * 1. **Only the connector may produce it.** It knows which of its fields are IDENTIFIERS
 *    (Scrive's `clientId`/`tokenId` — the labels its own UI calls "credentials
 *    identifier") and which are secrets. The platform cannot guess, and must not.
 * 2. **A secret field is never returned whole.** `masked: true` means the value has been
 *    reduced — the shipped rule is a bullet run plus the last four characters, enough to
 *    tell two credentials apart by eye and not enough to use. A short value is masked
 *    entirely rather than mostly revealed.
 */
export const connectionCredentialField = z.object({
  key: z.string().min(1).max(64),
  /** The provider's own name for the field, as its UI writes it. */
  label: z.string().min(1).max(80),
  /** Verbatim when `masked` is false; reduced when true. Never the whole secret. */
  value: z.string().max(200),
  masked: z.boolean(),
});
export type ConnectionCredentialField = z.infer<typeof connectionCredentialField>;

export const connectionCredential = z.object({ fields: z.array(connectionCredentialField).max(16) });
export type ConnectionCredential = z.infer<typeof connectionCredential>;

/**
 * A cell sealed to a recipient's public key (#687) — the shape a
 * `SealedSecret` takes when it travels as DATA rather than as a kernel type.
 *
 * Structurally identical to the kernel's `SealedSecret`, and declared here for
 * the reason every other travelling shape is: an engine and a connector both
 * have to parse it at their own boundary ("parse, don't trust"), and neither may
 * depend on the other. `ciphertext` is opaque to everything but the holder of
 * the named private half — the console, the timeline and every future consumer
 * of a payload carrying one read it as bytes and nothing more.
 *
 * `keyId` is not decoration: a cell that cannot name its key can only ever have
 * one key, and rotating retroactively becomes impossible the day a second exists
 * (signature-contact-carrier.md D-4).
 */
export const sealedCell = z.object({
  keyId: z.string().min(1),
  ciphertext: z.string().min(1),
});
export type SealedCell = z.infer<typeof sealedCell>;

/**
 * A connection's PUBLIC sealing key as it travels into a deployment (#687) —
 * delivered with provision/reconcile exactly as entitlements (#310), identity
 * links (#406) and connection grants (#592) are, and projected into the scope so
 * module code can seal a value TO the connector before emitting it.
 *
 * **The private half is never here and can never be.** Projecting a secret key
 * into a scope is precisely the failure kernel-design §13.1 names — a key
 * restored by the same dump that restores its ciphertext reverses every erasure
 * the restore rolled past. §2 of the carrier design closes that door; it says
 * nothing about a public key, and that gap is the whole mechanism. Projecting
 * this leaks nothing: it lets a scope WRITE to the connector, never read.
 *
 * Keyed by `provider` as well as `connectionId` because that is what module code
 * knows. An engine emitting `method: 'scrive'` has no connection id and must not
 * acquire one — connection identity is the host's business.
 */
export const projectedConnectionKey = z.object({
  connectionId: z.string().min(1),
  provider: z.string().min(1),
  keyId: z.string().min(1),
  /** SEC1 uncompressed P-256 point, base64. Public by construction. */
  publicKey: z.string().min(1),
});
export type ProjectedConnectionKey = z.infer<typeof projectedConnectionKey>;
