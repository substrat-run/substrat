import { opsFailureFingerprint, type OpsFailureEntry } from '@substrat-run/contracts';

/**
 * One failure shape on MY vertical (#1233, the builder slice): the same
 * fingerprint grouping the staff issues store materializes, derived here from
 * the tenant-forced failure rows instead. Deliberately derived, not read from
 * `/issues`: an issue is a fleet-scoped aggregate with no tenant column, so the
 * staff store cannot be narrowed to a builder — but every failure row carries
 * its fingerprint, and a builder's own rows group the same way. The price is
 * honest and stated in the UI: counts cover the evidence window (90-day
 * retention), not all time, and there is no lifecycle — verdicts are staff
 * concerns on the fleet store.
 */
export interface FailureGroupRow {
  fingerprint: string;
  operation: string;
  stage: string | null;
  /** The taxonomy code when the refusal was ours — the shape's error half. */
  code: string | null;
  origin: string | null;
  /** Occurrences within the evidence window — NOT an all-time count. */
  count: number;
  firstSeen: string;
  lastSeen: string;
  /** The newest occurrence's message — a sample, not the group's identity. */
  lastMessage: string;
  lastStatus: number | null;
}

/**
 * Group failure rows by fingerprint, newest-first in and out. A row written
 * before the fingerprint column (#1290) has null there; its key is computed
 * from the same (operation, stage, code) triple, so old evidence groups with
 * new rather than each old row standing alone.
 */
export function deriveFailureGroups(rows: OpsFailureEntry[]): FailureGroupRow[] {
  const groups = new Map<string, FailureGroupRow>();
  for (const row of rows) {
    const fingerprint = row.fingerprint ?? opsFailureFingerprint(row);
    const existing = groups.get(fingerprint);
    if (existing === undefined) {
      // Rows arrive newest first, so the first row seen is the group's newest.
      groups.set(fingerprint, {
        fingerprint,
        operation: row.operation,
        stage: row.stage,
        code: row.code,
        origin: row.origin,
        count: 1,
        firstSeen: row.at,
        lastSeen: row.at,
        lastMessage: row.message,
        lastStatus: row.status,
      });
    } else {
      existing.count += 1;
      // Walking newest → oldest, so each later row pushes firstSeen back.
      existing.firstSeen = row.at;
      // The newest classification wins, but an older row may carry what the
      // newest lacks (a writer that could not say) — same COALESCE the store uses.
      existing.origin = existing.origin ?? row.origin;
    }
  }
  return [...groups.values()].sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : 0));
}
