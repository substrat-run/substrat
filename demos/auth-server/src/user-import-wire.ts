/**
 * The wire contract of `POST /__admin/users/import` — limits and shapes, nothing else.
 *
 * Dependency-free on purpose: the admin app imports it type-and-constant-only, so the browser
 * and `src/user-import.ts` agree by construction rather than by two hand-kept copies. A new
 * outcome added here is a compile error in the screen that sums them, not a `NaN` on it.
 */

/** People written per call. Each batch commits whole or not at all. */
export const IMPORT_BATCH_LIMIT = 500;

/**
 * People checked per DRY run. A dry run writes nothing, so a whole file is checked in one call
 * — which is what lets it see a duplicate on row 10 and row 550 together, as the real run
 * (batch 2 reading what batch 1 wrote) will. Split it, and the preview would stop matching.
 */
export const DRY_RUN_LIMIT = 10_000;

export interface ImportEntry {
  id: string;
  email: string;
  name?: string;
  emailVerified?: boolean;
  image?: string;
  createdAt?: string;
  passwordHash?: string;
  accounts?: { providerId: string; accountId: string }[];
}

export interface SkippedAccount {
  providerId: string;
  accountId: string;
  linkedTo: string;
}

export type ImportOutcome =
  | {
      id: string;
      outcome: 'created';
      password: boolean;
      accounts: string[];
      skippedAccounts: SkippedAccount[];
      /** The entry's own flag — `null` when it carried none, which is stored as unverified. */
      emailVerified: boolean | null;
    }
  | { id: string; outcome: 'merged'; password: boolean; accounts: string[]; skippedAccounts: SkippedAccount[] }
  | { id: string; outcome: 'unchanged'; skippedAccounts: SkippedAccount[] }
  | { id: string; outcome: 'conflict'; reason: 'email-taken'; existingId: string }
  | { id: string; outcome: 'conflict'; reason: 'email-differs'; existingEmail: string };

export type ImportCounts = Record<ImportOutcome['outcome'], number>;

/**
 * The CREATED people whose address arrives unverified (#1359), named the way
 * `identifyEmail` in `@substrat-run/oidc-rp` names its refusals: `unasserted` carried no
 * flag at all, `unverified` carried `false`. A relying party that identifies someone by
 * address refuses both, so an export that dropped the column locks every one of them out
 * of a staff roster or an invite. Merged and unchanged people keep the flag already stored
 * here, so they are never counted.
 */
export interface UnverifiedCounts {
  unasserted: number;
  unverified: number;
}

export interface ImportResult {
  dryRun: boolean;
  results: ImportOutcome[];
  counts: ImportCounts;
  unverified: UnverifiedCounts;
}

export const emptyCounts = (): ImportCounts => ({ created: 0, merged: 0, unchanged: 0, conflict: 0 });

export const emptyUnverified = (): UnverifiedCounts => ({ unasserted: 0, unverified: 0 });
