import {
  MAIL_IN_PROVIDER,
  connectionId as connectionIdSchema,
  instant,
  mailInAddress,
  permissionKey,
  type Connection,
  type ConnectionId,
  type MailInAddress,
  type PlatformActorId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { isPrimaryScope, ulid, type ScopeHost } from '@substrat-run/kernel';
import type { MailInStore } from './store.js';

/**
 * A scope's mail-in address, from request to revoke (#2611).
 *
 * **One address, one connection.** An address is minted as its own `mail-in` connection: the local
 * part is the connection's `externalAccountRef` (what the SMTP-time lookup selects on), the address
 * is its label, and the binding — which scope, which operation, which key, which senders — is its
 * connector state. So everything a connection already is, an address is too: revoking one
 * tombstones its grant and deletes its state, the connect and revoke are in the admin log, and what
 * a leaked address can do is one grant, on one scope, readable in `connectionGrantsInScope`.
 *
 * **What it may do is the vertical's declaration.** The operation and its key are read off the
 * manifest the scope RUNS (`connections: [{ provider: 'mail-in', … }]`), never taken from the
 * caller, so a scope cannot be made to receive mail into an operation its code did not name.
 */

export const STATE_PREFIX = 'mail-in:';
export const BINDING_KEY = `${STATE_PREFIX}address`;
export const STATS_KEY = `${STATE_PREFIX}stats`;
export const MESSAGE_PREFIX = `${STATE_PREFIX}msg:`;

/** The random part of an address: 16 base32 characters, 80 bits. */
const TOKEN_CHARS = 'abcdefghijklmnopqrstuvwxyz234567';
const TOKEN_LENGTH = 16;
/** The readable prefix of an address is the vertical's slug, cut to this. */
const SLUG_PART_MAX = 24;
/** What a local part the platform minted looks like. Anything else is not an address of ours. */
export const LOCAL_PART = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?-[a-z2-7]{16}$/;

/** Why a request was refused, with the status a relay answers it with. */
export class MailInError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 503,
  ) {
    super(message);
    this.name = 'MailInError';
  }
}

/** The landing a vertical declares for mail-in, as the running manifest says it. */
export interface MailInLanding {
  operation: string;
  permission: string;
}

/**
 * Where the platform reads a scope's declared landing: the running version's manifest. `null` is a
 * version that declares none; a throw is a manifest that cannot be read, which refuses rather than
 * guesses.
 */
export type MailInLandingOf = (scope: { tenantId: TenantId; scopeId: ScopeId; vertical: string; verticalVersionId: string | null; servingRef: string | null }) => Promise<MailInLanding | null>;

export interface MailInAddressDeps {
  actor: PlatformActorId;
  /** The receiving domain, e.g. `in.substrat.run`. Absent ⇒ this deployment receives no mail. */
  domain: string | undefined;
  landingOf: MailInLandingOf;
  /** Where accepted messages wait; revoking an address deletes what is still in it. */
  store: MailInStore;
  now?: () => Date;
}

/** The binding an address's connection keeps. */
export interface MailInBinding {
  address: string;
  tenantId: string;
  scopeId: string;
  vertical: string;
  operation: string;
  permission: string;
  allowlist: string[];
  createdAt: string;
  createdBy: string;
}

export interface MailInStats {
  received: number;
  delivered: number;
  rejected: number;
  deadLettered: number;
  lastReceivedAt: string | null;
  lastRejectedAt: string | null;
  lastRejectReason: string | null;
}

export const EMPTY_STATS: MailInStats = {
  received: 0,
  delivered: 0,
  rejected: 0,
  deadLettered: 0,
  lastReceivedAt: null,
  lastRejectedAt: null,
  lastRejectReason: null,
};

/**
 * One accepted message, as its connection's state keeps it — never its bytes. The envelope sender
 * is kept only until delivery hands it to the scope; a delivered record is the dedupe key alone.
 */
export interface MailInMessageEntry {
  status: 'pending' | 'delivered' | 'dead-lettered';
  receivedAt: string;
  size: number;
  /** Where the raw message waits until it is delivered. */
  objectKey: string;
  envelopeFrom?: string;
  attempts: number;
  nextAttemptAt: string;
  lastError?: string;
  /** Set once the message change landed: the entity the operation answered, if any. */
  invoked?: { entity: { entityType: string; entityId: string } | null };
  /** Attachment index → the attachment id it landed as. */
  landed: Record<string, string>;
  deliveredAt?: string;
}

const nowOf = (deps: { now?: () => Date }) => (deps.now ?? (() => new Date()))();

function token(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_LENGTH));
  let out = '';
  for (const b of bytes) out += TOKEN_CHARS[b % 32];
  return out;
}

/** `meridian-x7k…` from a vertical slug: its readable part, then the token. */
export function mintLocalPart(vertical: string): string {
  const slug =
    vertical
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, SLUG_PART_MAX)
      .replace(/-+$/g, '') || 'mail';
  return `${slug}-${token()}`;
}

/**
 * The local part a recipient address names, normalised: lowercased, with a `+tag` dropped. Null
 * for an address not at `domain`, or one whose local part is not one the platform mints.
 */
export function localPartOf(recipient: string, domain: string): string | null {
  const at = recipient.lastIndexOf('@');
  if (at <= 0) return null;
  if (recipient.slice(at + 1).toLowerCase() !== domain.toLowerCase()) return null;
  const local = recipient.slice(0, at).toLowerCase().split('+')[0]!;
  return LOCAL_PART.test(local) ? local : null;
}

export async function readBinding(host: Pick<ScopeHost, 'admin'>, id: ConnectionId): Promise<MailInBinding | undefined> {
  const v = await host.admin.getConnectorState(id, BINDING_KEY);
  return v && typeof v === 'object' ? (v as MailInBinding) : undefined;
}

export async function readStats(host: Pick<ScopeHost, 'admin'>, id: ConnectionId): Promise<MailInStats> {
  const v = await host.admin.getConnectorState(id, STATS_KEY);
  return v && typeof v === 'object' ? { ...EMPTY_STATS, ...(v as Partial<MailInStats>) } : { ...EMPTY_STATS };
}

export async function bumpStats(
  host: Pick<ScopeHost, 'admin'>,
  id: ConnectionId,
  change: (s: MailInStats) => MailInStats,
): Promise<void> {
  await host.admin.putConnectorState(id, STATS_KEY, change(await readStats(host, id)));
}

export async function messageEntries(host: Pick<ScopeHost, 'admin'>, id: ConnectionId): Promise<{ key: string; entry: MailInMessageEntry }[]> {
  return (await host.admin.listConnectorState(id, MESSAGE_PREFIX))
    .filter((r) => r.value !== null && typeof r.value === 'object')
    .map((r) => ({ key: r.key, entry: r.value as MailInMessageEntry }));
}

/** The live mail-in connection holding this scope's address, with its binding. */
async function liveAddress(
  host: ScopeHost,
  actor: PlatformActorId,
  tenantId: TenantId,
  scopeId: ScopeId,
): Promise<{ connection: Connection; binding: MailInBinding } | undefined> {
  const rows = await host.admin.listConnections(actor, { tenantId, provider: MAIL_IN_PROVIDER });
  for (const connection of rows) {
    if (connection.revokedAt) continue;
    const binding = await readBinding(host, connection.id);
    if (binding?.scopeId === scopeId) return { connection, binding };
  }
  return undefined;
}

async function view(host: ScopeHost, connection: Connection, binding: MailInBinding): Promise<MailInAddress> {
  const [stats, entries] = await Promise.all([readStats(host, connection.id), messageEntries(host, connection.id)]);
  return mailInAddress.parse({
    address: binding.address,
    connectionId: connection.id,
    tenantId: binding.tenantId,
    scopeId: binding.scopeId,
    vertical: binding.vertical,
    operation: binding.operation,
    permission: binding.permission,
    allowlist: binding.allowlist,
    createdAt: binding.createdAt,
    createdBy: binding.createdBy,
    stats: { ...stats, pending: entries.filter((e) => e.entry.status === 'pending').length },
  });
}

/** This scope's live address, or null. */
export async function mailInAddressOf(
  host: ScopeHost,
  actor: PlatformActorId,
  tenantId: TenantId,
  scopeId: ScopeId,
): Promise<MailInAddress | null> {
  const live = await liveAddress(host, actor, tenantId, scopeId);
  return live ? view(host, live.connection, live.binding) : null;
}

/** Every live address of a tenant, for a console. */
export async function listMailInAddresses(host: ScopeHost, actor: PlatformActorId, tenantId: TenantId): Promise<MailInAddress[]> {
  const out: MailInAddress[] = [];
  for (const connection of await host.admin.listConnections(actor, { tenantId, provider: MAIL_IN_PROVIDER })) {
    if (connection.revokedAt) continue;
    const binding = await readBinding(host, connection.id);
    if (binding) out.push(await view(host, connection, binding));
  }
  return out;
}

/** The scope, held to what may receive mail: a live, primary scope running a vertical that declares a landing. */
async function receivingScope(
  host: ScopeHost,
  deps: MailInAddressDeps,
  tenantId: TenantId,
  scopeId: ScopeId,
): Promise<{ vertical: string; landing: MailInLanding }> {
  if (!deps.domain) {
    throw new MailInError('inbound mail is not configured on this deployment (MAIL_IN_DOMAIN unset on the control plane)', 503);
  }
  const rec = await host.admin.getScopeRecord(deps.actor, tenantId, scopeId);
  if (!rec?.vertical) throw new MailInError('scope has no vertical bound', 404);
  // #2005: a preview or a fork causes no outbound effects, and an address would make one receive
  // mail meant for the tenant's real scope.
  if (!isPrimaryScope(rec)) throw new MailInError('a preview or a fork cannot have a mail-in address', 403);
  if (rec.status !== 'active') throw new MailInError(`scope is ${rec.status}, not active`, 409);
  const landing = await deps.landingOf({
    tenantId,
    scopeId,
    vertical: rec.vertical,
    verticalVersionId: rec.verticalVersionId ?? null,
    servingRef: rec.servingRef ?? null,
  });
  if (!landing) {
    throw new MailInError(
      `vertical '${rec.vertical}' declares no mail-in landing — add { provider: '${MAIL_IN_PROVIDER}', operation, permission } to its manifest's connections`,
      409,
    );
  }
  return { vertical: rec.vertical, landing };
}

/** Mint a connection, grant it the landing's key on the scope, and write its binding. */
async function mint(
  host: ScopeHost,
  deps: MailInAddressDeps,
  input: { tenantId: TenantId; scopeId: ScopeId; vertical: string; landing: MailInLanding; allowlist: string[]; createdBy: string },
): Promise<{ connection: Connection; binding: MailInBinding }> {
  const local = mintLocalPart(input.vertical);
  const address = `${local}@${deps.domain!.toLowerCase()}`;
  const id = connectionIdSchema.parse(ulid());
  await host.admin.createConnection(deps.actor, {
    id,
    tenantId: input.tenantId,
    vertical: input.vertical,
    provider: MAIL_IN_PROVIDER,
    label: address,
    externalAccountRef: local,
    // Nothing to seal: the address is the capability, and it is not a secret from its own tenant.
    secret: { address },
    createdBy: input.createdBy,
  });
  await host.admin.grantToConnection(deps.actor, {
    connectionId: id,
    permission: permissionKey.parse(input.landing.permission),
    node: { tenantId: input.tenantId, scopeId: input.scopeId },
    grantedBy: deps.actor,
  });
  const binding: MailInBinding = {
    address,
    tenantId: input.tenantId,
    scopeId: input.scopeId,
    vertical: input.vertical,
    operation: input.landing.operation,
    permission: input.landing.permission,
    allowlist: input.allowlist,
    createdAt: instant.parse(nowOf(deps).toISOString()),
    createdBy: input.createdBy,
  };
  await host.admin.putConnectorState(id, BINDING_KEY, binding);
  const connection = (await host.admin.listConnections(deps.actor, { tenantId: input.tenantId, provider: MAIL_IN_PROVIDER, externalAccountRef: local }))[0];
  if (!connection) throw new Error(`the connection for ${address} was created and cannot be read back`);
  return { connection, binding };
}

/**
 * Give the scope an address, or answer the one it has. An `allowlist` replaces the live address's
 * list; absent keeps it (or starts empty).
 */
export async function requestMailInAddress(
  host: ScopeHost,
  deps: MailInAddressDeps,
  input: { tenantId: TenantId; scopeId: ScopeId; createdBy: string; allowlist?: string[] },
): Promise<MailInAddress> {
  const { vertical, landing } = await receivingScope(host, deps, input.tenantId, input.scopeId);
  const live = await liveAddress(host, deps.actor, input.tenantId, input.scopeId);
  if (live) {
    if (input.allowlist) {
      const binding = { ...live.binding, allowlist: input.allowlist };
      await host.admin.putConnectorState(live.connection.id, BINDING_KEY, binding);
      return view(host, live.connection, binding);
    }
    return view(host, live.connection, live.binding);
  }
  const minted = await mint(host, deps, { ...input, vertical, landing, allowlist: input.allowlist ?? [] });
  return view(host, minted.connection, minted.binding);
}

/**
 * Replace the scope's address with a new one. The old one is revoked, so mail to it is refused from
 * here on; whatever it accepted and has not delivered moves to the new connection, so nothing in
 * flight is lost. The landing is re-read, so a rotation also picks up a changed declaration.
 */
export async function rotateMailInAddress(
  host: ScopeHost,
  deps: MailInAddressDeps,
  input: { tenantId: TenantId; scopeId: ScopeId; createdBy: string; allowlist?: string[] },
): Promise<MailInAddress> {
  const live = await liveAddress(host, deps.actor, input.tenantId, input.scopeId);
  if (!live) throw new MailInError('this scope has no mail-in address to rotate', 404);
  const { vertical, landing } = await receivingScope(host, deps, input.tenantId, input.scopeId);
  const next = await mint(host, deps, {
    tenantId: input.tenantId,
    scopeId: input.scopeId,
    vertical,
    landing,
    allowlist: input.allowlist ?? live.binding.allowlist,
    createdBy: input.createdBy,
  });
  for (const { key, entry } of await messageEntries(host, live.connection.id)) {
    if (entry.status !== 'delivered') await host.admin.putConnectorState(next.connection.id, key, entry);
  }
  await host.admin.revokeConnection(deps.actor, live.connection.id);
  return view(host, next.connection, next.binding);
}

/**
 * Give the address up: mail to it is refused at SMTP time from now on, and what it accepted and had
 * not delivered is deleted with it. `false` when the scope had none.
 */
export async function revokeMailInAddress(
  host: ScopeHost,
  deps: Pick<MailInAddressDeps, 'actor' | 'store'>,
  input: { tenantId: TenantId; scopeId: ScopeId },
): Promise<boolean> {
  const live = await liveAddress(host, deps.actor, input.tenantId, input.scopeId);
  if (!live) return false;
  for (const { entry } of await messageEntries(host, live.connection.id)) {
    if (entry.status !== 'delivered') await deps.store.delete(entry.objectKey);
  }
  await host.admin.revokeConnection(deps.actor, live.connection.id);
  return true;
}
