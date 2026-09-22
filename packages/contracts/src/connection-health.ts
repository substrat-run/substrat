import { z } from 'zod';
import { instant, tenantId } from './ids.js';
import { connectionId, connectionProvider, connectionStatus, type Connection } from './connections.js';

/**
 * Fleet-wide connection health (#1690) — what the staff console's Health →
 * Connections view reads, derived from the §3.7 columns every connection
 * already carries (`lastOkAt` / `lastError` / `lastErrorAt`).
 *
 * The derivation is ONE pure function so the route, its tests and any later
 * reader (a push-side alert, #1416) cannot disagree about what "healthy" means.
 */

/**
 * How long a success stays evidence of health. Seven days, because the only
 * lifetime this platform knows is Scrive's 30-day refresh (connections.md §3.6):
 * a connection that idles past it is dead, and §3.6 says the tenant must hear
 * before a request fails. Stale at 7 leaves three weeks to act on it. It is also
 * one business week — a connection a weekly flow uses is never stale.
 */
export const CONNECTION_STALE_DAYS = 7;

/**
 * How far ahead a known grant expiry (`expiresAt`) is flagged. Seven days: the
 * last week of a 30-day refresh window, and long enough to span a weekend
 * between the warning and the reconnect. Independent of the stale window on
 * purpose — an idle Scrive connection reads stale at day 7 and expiring at 23.
 */
export const CONNECTION_EXPIRY_WARNING_DAYS = 7;

export const connectionHealthState = z.enum([
  /** The latest outcome is a success, inside the stale window. */
  'healthy',
  /** The latest outcome is an error (or the grant is recorded as expired). */
  'erroring',
  /** The latest outcome is a success, but older than the stale window. */
  'stale',
  /**
   * No outcome at all. A fresh credential carries no health until its first
   * dispatch (§3.8, #605) — so this is NOT healthy, and never renders as it.
   */
  'never-used',
]);
export type ConnectionHealthState = z.infer<typeof connectionHealthState>;

const DAY_MS = 86_400_000;
const ms = (at: string | Date): number => (typeof at === 'string' ? Date.parse(at) : at.getTime());

/**
 * The health of one connection at `now`.
 *
 * - no `lastOkAt` and no `lastErrorAt` ⇒ `never-used`;
 * - an error at least as recent as the last success ⇒ `erroring` (a tie is not
 *   evidence of health, so it resolves to the conservative answer);
 * - `status: 'expired'` ⇒ `erroring` whatever the outcomes say — the grant has
 *   lapsed, so the next call fails;
 * - a success at least `staleDays` old ⇒ `stale` (the boundary is stale);
 * - otherwise `healthy`.
 */
export function deriveConnectionHealth(
  c: Pick<Connection, 'status' | 'lastOkAt' | 'lastErrorAt'>,
  now: string | Date,
  staleDays: number = CONNECTION_STALE_DAYS,
): ConnectionHealthState {
  if (c.status === 'expired') return 'erroring';
  if (c.lastErrorAt !== null && (c.lastOkAt === null || ms(c.lastErrorAt) >= ms(c.lastOkAt))) {
    return 'erroring';
  }
  if (c.lastOkAt === null) return 'never-used';
  return ms(now) - ms(c.lastOkAt) >= staleDays * DAY_MS ? 'stale' : 'healthy';
}

export const connectionExpiryWarning = z.enum(['soon', 'expired']);
export type ConnectionExpiryWarning = z.infer<typeof connectionExpiryWarning>;

/**
 * The refresh-expiry early warning (§3.6): `expired` once `expiresAt` has
 * passed, `soon` inside the warning window, `null` otherwise — including when
 * the provider records no expiry at all, which is not a warning.
 */
export function deriveExpiryWarning(
  expiresAt: string | null,
  now: string | Date,
  warningDays: number = CONNECTION_EXPIRY_WARNING_DAYS,
): ConnectionExpiryWarning | null {
  if (expiresAt === null) return null;
  const left = ms(expiresAt) - ms(now);
  if (left <= 0) return 'expired';
  return left <= warningDays * DAY_MS ? 'soon' : null;
}

/**
 * One row of the fleet read. An explicit allow-list of `Connection` fields —
 * never the row spread — so a field added upstream (or an adapter that starts
 * returning more than the contract) does not ride out to a console by default.
 * `createdBy`, `scopes` and `revokedAt` are deliberately absent: the view has no
 * use for them, and a principal id is not something a health table should carry.
 * `.strict()` so the route's own test can refuse a widened row.
 */
export const connectionHealthEntry = z
  .object({
    id: connectionId,
    tenantId,
    vertical: z.string().min(1),
    provider: connectionProvider,
    label: z.string().min(1),
    externalAccountRef: z.string().nullable(),
    status: connectionStatus,
    health: connectionHealthState,
    lastOkAt: instant.nullable(),
    lastError: z.string().nullable(),
    lastErrorAt: instant.nullable(),
    expiresAt: instant.nullable(),
    expiryWarning: connectionExpiryWarning.nullable(),
    createdAt: instant,
  })
  .strict();
export type ConnectionHealthEntry = z.infer<typeof connectionHealthEntry>;

/** Project a connection into its health row — the ONE place the allow-list lives. */
export function toConnectionHealthEntry(c: Connection, now: string | Date): ConnectionHealthEntry {
  return {
    id: c.id,
    tenantId: c.tenantId,
    vertical: c.vertical,
    provider: c.provider,
    label: c.label,
    externalAccountRef: c.externalAccountRef,
    status: c.status,
    health: deriveConnectionHealth(c, now),
    lastOkAt: c.lastOkAt,
    lastError: c.lastError,
    lastErrorAt: c.lastErrorAt,
    expiresAt: c.expiresAt,
    expiryWarning: deriveExpiryWarning(c.expiresAt, now),
    createdAt: c.createdAt,
  };
}

/**
 * Connector dead letters for one provider, counted from the fleet's ops-failure
 * record over a window. `capped` means the count hit the read's bound and is a
 * floor, not a total.
 */
export const connectorDeadLetterCount = z.object({
  provider: connectionProvider,
  count: z.number().int().nonnegative(),
  capped: z.boolean(),
});
export type ConnectorDeadLetterCount = z.infer<typeof connectorDeadLetterCount>;

/** What `GET /connections/health` answers. */
export interface ConnectionHealthPage {
  entries: ConnectionHealthEntry[];
  nextCursor: string | null;
  /** Counts over the tenant/provider-filtered set, BEFORE the health filter — the chips' numbers. */
  summary: Record<ConnectionHealthState, number> & { total: number; expiring: number };
  deadLetters: ConnectorDeadLetterCount[];
  /** The start of the dead-letter window. */
  deadLettersSince: string;
  staleAfterDays: number;
  expiryWarningDays: number;
  asOf: string;
}
