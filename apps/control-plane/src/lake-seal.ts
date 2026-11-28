/**
 * #3464 (K-37 limit 6): whether the drain seals each event's personal data under its subject's
 * key on the way to the lake (`LAKE_PAYLOAD_SEAL`). Read by the pass and by a scope's kicked
 * drain alike, so the two paths that ship to the stream cannot disagree.
 *
 * Unset is `off`, so a deploy changes nothing until the switch is set. `on` seals. Any other value
 * is logged and read as `on`: this switch guards personal data, and sealing costs no reader
 * anything (the lake gateway returns no payload), so a typo errs toward the erasure reaching the
 * lake rather than toward plaintext.
 */
export function lakePayloadSealOf(raw: string | undefined, warn: (message: string) => void = console.warn): boolean {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === '' || value === 'off') return false;
  if (value !== 'on') warn(`LAKE_PAYLOAD_SEAL '${raw}' is not on or off; read as on, so the lake's payloads are sealed`);
  return true;
}
