import type { ConnectionId } from '@substrat-run/contracts';
import type { HostAdmin } from '@substrat-run/kernel';

/**
 * Which sender addresses have sent (#2343). Mail cannot be probed without sending — the app
 * deliberately cannot read a mailbox — so the evidence is a send: each one Graph accepts is
 * recorded under its `from` address, and the probe and the credential view read it back.
 *
 * A send reads one row and writes only when its address has no record or a record over a day
 * old, so ordinary mail through the relay costs no write per message. A failed send writes
 * nothing and clears nothing: the connection's health already shows the failure.
 */
const PREFIX = 'microsoft365:mail-verified:';
const MAIL_VERIFIED_REFRESH_MS = 86_400_000;

type Verified = { at: string };
const keyOf = (address: string) => `${PREFIX}${address.toLowerCase()}`;

export async function recordMailVerified(admin: HostAdmin, connectionId: ConnectionId, address: string, now: Date) {
  const key = keyOf(address);
  const prior = (await admin.getConnectorState(connectionId, key)) as Verified | undefined;
  if (prior && now.getTime() - Date.parse(prior.at) < MAIL_VERIFIED_REFRESH_MS) return;
  await admin.putConnectorState(connectionId, key, { at: now.toISOString() } satisfies Verified);
}

/** Each current sender with the day of its last recorded send, or `null`. A removed sender's record is left out. */
export async function mailVerifiedOf(
  admin: HostAdmin,
  connectionId: ConnectionId,
  senders: readonly string[],
): Promise<[string, string | null][]> {
  const at = new Map(
    (await admin.listConnectorState(connectionId, PREFIX)).map((r) => [r.key, (r.value as Verified).at.slice(0, 10)]),
  );
  return senders.map((s) => [s, at.get(keyOf(s)) ?? null]);
}

/** The two lines the probe and the credential view show: verified senders with their day, and the rest. */
export function mailLines(senders: readonly [string, string | null][]) {
  const verified = senders.filter(([, at]) => at).map(([s, at]) => `${s} (${at})`);
  const unverified = senders.filter(([, at]) => !at).map(([s]) => s);
  return {
    verified: verified.length ? verified.join(', ') : null,
    unverified: unverified.length ? `${unverified.join(', ')} — until the first send or a send test` : null,
  };
}
