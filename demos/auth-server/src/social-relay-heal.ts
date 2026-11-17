import { relayProviderId } from '@substrat-run/contracts';
import type { SqlExec } from './introspect.js';
import { readProviders } from './providers.js';
import { relayClientId, relayOrigin } from './social-relay.js';

/**
 * The install's half of the social relay's self-heal (#1544): asking the platform to register
 * THIS install at its social relay, when the platform's own triggers left it without its
 * "provided by Substrat" rows — an install-time reconcile that failed, an install older than the
 * relay, or one registered before the relay gained a provider.
 *
 * There is no timer. Two things ask:
 *
 *   - **Opening the Connections page** (automatic). Due when no relay client is held, or the relay
 *     now serves a provider this install has no `<upstream>-relay` row for. Debounced by a stored
 *     last-attempt time (`AUTO_HEAL_INTERVAL_MS`), so a page opened often or a platform that keeps
 *     failing is asked at most once per interval. The relay's providers are read from its public
 *     `GET /providers`, at the origin this install's own delivered rows name — so with no client
 *     held there is no origin, and "no client" alone decides.
 *   - **The operator's "Set up" button** (manual), which asks whatever the last attempt was.
 *
 * This file is what the issuer DO keeps: the claim, its debounce and what it came to. The ask
 * itself (`social-relay-self.ts`) is made from the WORKER's request path, never from inside the
 * Durable Object: the egress worker proves which vertical and scope are calling only for a
 * worker's own subrequests, and a call from a Durable Object would reach the platform carrying
 * the platform credential alone.
 *
 * Standalone (no platform credential, or nothing provisioned this issuer) the feature is absent:
 * nothing is claimed, nothing is asked, and the page says nothing about it.
 */

/** Where the last attempt is remembered (`config`): `HealRecord`, as JSON. */
const HEAL_KEY = 'social_relay_heal';

/** How long after one attempt opening the Connections page may ask again. */
export const AUTO_HEAL_INTERVAL_MS = 60 * 60_000;

/** What one attempt came to, as the operator is shown it. */
export type HealResult =
  | { status: 'delivered'; providers: string[] }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string }
  /** The automatic check found nothing missing, so the platform was not asked. */
  | { status: 'current' };

export interface HealRecord {
  /** When the attempt was claimed, ISO 8601. */
  at: string;
  trigger: 'auto' | 'manual';
  /** Absent while the attempt is in flight, or when it never reported back. */
  result?: HealResult;
}

/** What the worker needs to make one attempt: who to ask for, and what to compare. */
export interface HealClaim {
  tenantId: string;
  scopeId: string;
  /** This install holds a relay client — the platform must then never rotate its secret. */
  hasClient: boolean;
  /** The relay's origin, read off a delivered row; null when nothing was delivered yet. */
  relayOrigin: string | null;
  /** Every provider id this install has a row under, the operator's own included. */
  providerIds: string[];
}

export function readHealRecord(sql: SqlExec): HealRecord | null {
  const row = sql.exec('SELECT value FROM config WHERE key = ?', HEAL_KEY).toArray()[0] as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as HealRecord;
  } catch {
    return null;
  }
}

function writeHealRecord(sql: SqlExec, record: HealRecord): void {
  sql.exec('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', HEAL_KEY, JSON.stringify(record));
}

/**
 * Claim an attempt, recording it before it is made so a second page load inside the interval
 * finds it — even while the first is still in flight, and even if it never reports back. An
 * automatic claim inside the interval is null; a manual one always succeeds. Null too for an
 * install the platform never provisioned (`instance` is its record of who it is).
 */
export function claimHeal(
  sql: SqlExec,
  instance: { tenantId: string; scopeId: string } | undefined,
  trigger: 'auto' | 'manual',
  now: Date,
  intervalMs: number = AUTO_HEAL_INTERVAL_MS,
): HealClaim | null {
  if (!instance) return null;
  if (trigger === 'auto') {
    const last = readHealRecord(sql);
    const lastAt = last ? Date.parse(last.at) : Number.NaN;
    if (!Number.isNaN(lastAt) && now.getTime() - lastAt < intervalMs) return null;
  }
  writeHealRecord(sql, { at: now.toISOString(), trigger });
  return {
    tenantId: instance.tenantId,
    scopeId: instance.scopeId,
    hasClient: relayClientId(sql) !== null,
    relayOrigin: relayOrigin(sql),
    providerIds: readProviders(sql).map((r) => r.provider_id),
  };
}

/** Record what the claimed attempt came to, beside the time it was claimed. */
export function recordHealResult(sql: SqlExec, result: HealResult): void {
  const last = readHealRecord(sql);
  if (!last) return;
  writeHealRecord(sql, { ...last, result });
}

/** The upstreams the relay serves that this install has no `<upstream>-relay` row for. */
export function missingRelayProviders(served: readonly string[], providerIds: readonly string[]): string[] {
  const held = new Set(providerIds);
  return served.filter((id) => !held.has(relayProviderId(id)));
}
