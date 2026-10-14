import { z } from 'zod';
import type { SqlExec } from './introspect.js';
import { isBcryptHash } from './legacy-password.js';
import {
  DRY_RUN_LIMIT,
  IMPORT_BATCH_LIMIT,
  emptyCounts,
  emptyUnverified,
  type ImportEntry,
  type ImportOutcome,
  type ImportResult,
  type SkippedAccount,
} from './user-import-wire.js';

/**
 * Bringing people over from another issuer — `POST /__admin/users/import`.
 *
 * The one property everything here protects is the person's ID. A relying party knows somebody
 * by the `sub` its issuer put in their ID token, and this issuer's `sub` is `user.id`. So an
 * imported person keeps the id the OLD issuer gave them, verbatim, and every relying party that
 * keyed a workspace, a grant or a membership on it goes on recognising them after it changes
 * issuer. An import that minted fresh ids would make every migrated person a stranger.
 *
 * What one entry may carry, and what becomes of it:
 *
 *  - the user row — id, email, name, whether the email was verified, when they joined. An
 *    entry with no `emailVerified` is stored as unverified, never guessed verified; the result
 *    counts those people (`unverified.unasserted`) apart from the ones the file marks `false`,
 *    because an export that dropped the column is a lockout at every relying party that
 *    identifies someone by address (#1359), and the dry run is where that is cheap to see;
 *  - a password, as the old issuer's bcrypt hash. Stored as the `credential` account Better
 *    Auth's own sign-up writes, and checked by `legacyAwarePassword` until they next set one;
 *  - the upstream identities they signed in with (`github` + GitHub's numeric user id, …), as
 *    `account` rows. Without them the first "Sign in with GitHub" finds the address taken and
 *    stops at the account-linking refusal, which is exactly what a migration must not show.
 *
 * Re-runnable on purpose, because a migration runs twice at least — once ahead of the switch
 * and once after it, for whoever signed up in between:
 *
 *  - an id already here with the SAME email is merged: a password is added if they have none,
 *    upstream identities they lack are added. Nothing already here is overwritten — least of
 *    all a password they set on this issuer, which is newer than any hash being imported.
 *  - an email already here under a DIFFERENT id is a conflict, reported and untouched. Better
 *    Auth allows one person per address, so the two have to become one, and which id survives
 *    is a decision about who already knows them by which `sub` — not one an import can make.
 *  - an upstream identity already linked to somebody else is skipped and reported, for the
 *    same reason.
 *
 * `dryRun` answers all of that without writing, so the collisions can be read before anything
 * moves — for a whole file at once (`DRY_RUN_LIMIT`), so a duplicate on row 10 and row 550 is
 * seen together, exactly as the real run's second batch will see what its first one wrote.
 * A real run is at most `IMPORT_BATCH_LIMIT` and commits whole or not at all: the caller hands
 * in its runtime's transaction (the DO's `transactionSync`, better-sqlite3's `transaction`),
 * so a row that throws past the checks takes its batch with it instead of leaving half of it.
 *
 * The admin gate in front is the whole authorisation story: this endpoint writes credentials,
 * and only an `admin` session reaches it.
 */

const importedAccount = z.object({
  providerId: z
    .string()
    .min(1)
    .max(64)
    .refine((v) => v !== 'credential', 'a password is `passwordHash`, not an account'),
  accountId: z.string().min(1).max(255),
});

const importedUser = z.object({
  id: z.string().min(1).max(255),
  email: z.string().email().max(320),
  name: z.string().max(255).optional(),
  emailVerified: z.boolean().optional(),
  image: z.string().url().max(2048).optional(),
  createdAt: z.string().datetime({ offset: true }).optional(),
  passwordHash: z
    .string()
    .refine(isBcryptHash, 'not a bcrypt hash of cost 4–12 ($2a$/$2b$/$2y$) — nothing else can be verified here')
    .optional(),
  accounts: z.array(importedAccount).max(20).optional(),
});

export const importBody = z
  .object({
    users: z.array(importedUser).min(1).max(DRY_RUN_LIMIT),
    dryRun: z.boolean().optional(),
  })
  .refine((b) => b.dryRun === true || b.users.length <= IMPORT_BATCH_LIMIT, {
    message: `a real run writes at most ${IMPORT_BATCH_LIMIT} people per call; a dry run may check up to ${DRY_RUN_LIMIT}`,
    path: ['users'],
  });

export type ImportBody = z.infer<typeof importBody>;
type ImportedUser = z.infer<typeof importedUser>;

// The wire module is what the admin screen compiles against; these two lines are what keep the
// schema and it from drifting apart in either direction.
const _toWire = (u: ImportedUser): ImportEntry => u;
const _fromWire = (u: ImportEntry): ImportedUser => u;
void _toWire;
void _fromWire;

// boundary-lint-allow R6
// Not a Substrat row's stamp: `created_at`/`updated_at` on `user` and `account` are Better
// Auth's storage contract, the same class `auth-schema.ts` and `bankid.ts` are harness for.
// An admin request has no operation whose instant to borrow, and a row its library reads
// back must carry the time it was written.
const wallClock = (): number => Date.now();
// boundary-lint-end R6

const localPart = (email: string): string => email.slice(0, email.indexOf('@'));
const accountKey = (providerId: string, accountId: string): string => `${providerId}\u0000${accountId}`;

/**
 * What a dry run has decided to write so far, so a later entry in the same call answers as it
 * will once those writes exist. Both directions of the user map are kept: one lookup by id, one
 * by address, neither a scan.
 */
interface Planned {
  emailById: Map<string, string>;
  idByEmail: Map<string, string>;
  accounts: Map<string, string>;
  passwords: Set<string>;
}

export function importUsers(
  sql: SqlExec,
  body: ImportBody,
  transaction: <T>(fn: () => T) => T,
  now: number = wallClock(),
): ImportResult {
  const dryRun = body.dryRun ?? false;
  const planned: Planned = { emailById: new Map(), idByEmail: new Map(), accounts: new Map(), passwords: new Set() };
  const run = (): ImportOutcome[] => body.users.map((entry) => importOne(sql, entry, dryRun, planned, now));
  const results = dryRun ? run() : transaction(run);
  const counts = emptyCounts();
  const unverified = emptyUnverified();
  for (const r of results) {
    counts[r.outcome] += 1;
    if (r.outcome === 'created' && r.emailVerified !== true) unverified[r.emailVerified === null ? 'unasserted' : 'unverified'] += 1;
  }
  return { dryRun, results, counts, unverified };
}

function importOne(sql: SqlExec, entry: ImportedUser, dryRun: boolean, planned: Planned, now: number): ImportOutcome {
  // Better Auth stores addresses lower-cased and looks them up the same way, so an import
  // that kept the old issuer's casing would create a row its own sign-in can never find.
  const email = entry.email.trim().toLowerCase();

  // One read answers both questions: who holds this id, and who holds this address.
  const rows = sql.exec('SELECT id, email FROM user WHERE id = ? OR email = ?', entry.id, email).toArray() as {
    id: string;
    email: string;
  }[];
  const byEmail = rows.find((r) => r.email === email)?.id ?? planned.idByEmail.get(email);
  if (byEmail !== undefined && byEmail !== entry.id) {
    return { id: entry.id, outcome: 'conflict', reason: 'email-taken', existingId: byEmail };
  }
  const existingEmail = rows.find((r) => r.id === entry.id)?.email ?? planned.emailById.get(entry.id);
  if (existingEmail !== undefined && existingEmail !== email) {
    return { id: entry.id, outcome: 'conflict', reason: 'email-differs', existingEmail };
  }
  const exists = existingEmail !== undefined;

  // A `credential` row can exist with no hash (an invitation not yet accepted, a password an
  // administrator cleared). That row is filled in rather than joined by a second one: Better
  // Auth reads the first credential row it finds, and two would make sign-in a coin toss.
  const credential = sql
    .exec(`SELECT id, password FROM account WHERE user_id = ? AND provider_id = 'credential'`, entry.id)
    .toArray()[0] as { id: string; password: string | null } | undefined;
  const hasPassword = planned.passwords.has(entry.id) || (credential?.password ?? null) !== null;
  const addPassword = entry.passwordHash !== undefined && !hasPassword;

  const accounts: string[] = [];
  const skippedAccounts: SkippedAccount[] = [];
  const toLink: { providerId: string; accountId: string }[] = [];
  for (const account of entry.accounts ?? []) {
    const key = accountKey(account.providerId, account.accountId);
    const linkedTo =
      (
        sql
          .exec('SELECT user_id FROM account WHERE provider_id = ? AND account_id = ?', account.providerId, account.accountId)
          .toArray()[0] as { user_id: string } | undefined
      )?.user_id ?? planned.accounts.get(key);
    if (linkedTo === entry.id) continue;
    if (linkedTo !== undefined) {
      skippedAccounts.push({ ...account, linkedTo });
      continue;
    }
    if (toLink.some((a) => accountKey(a.providerId, a.accountId) === key)) continue;
    toLink.push(account);
    accounts.push(account.providerId);
  }

  if (exists && !addPassword && toLink.length === 0) {
    return { id: entry.id, outcome: 'unchanged', skippedAccounts };
  }

  if (dryRun) {
    planned.emailById.set(entry.id, email);
    planned.idByEmail.set(email, entry.id);
    if (addPassword) planned.passwords.add(entry.id);
    for (const a of toLink) planned.accounts.set(accountKey(a.providerId, a.accountId), entry.id);
  } else {
    if (!exists) {
      const joined = entry.createdAt ? Date.parse(entry.createdAt) : now;
      sql.exec(
        `INSERT INTO user (id, name, email, email_verified, image, created_at, updated_at, role)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'user')`,
        entry.id,
        entry.name?.trim() || localPart(email),
        email,
        entry.emailVerified ? 1 : 0,
        entry.image ?? null,
        joined,
        now,
      );
    }
    if (addPassword && credential) {
      sql.exec('UPDATE account SET password = ?, updated_at = ? WHERE id = ?', entry.passwordHash, now, credential.id);
    } else if (addPassword) {
      // The shape Better Auth's own email sign-up writes: provider `credential`, keyed on the
      // user's id, the hash in `password`.
      sql.exec(
        `INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at)
         VALUES (?, ?, 'credential', ?, ?, ?, ?)`,
        crypto.randomUUID(),
        entry.id,
        entry.id,
        entry.passwordHash,
        now,
        now,
      );
    }
    for (const a of toLink) {
      sql.exec(
        `INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        crypto.randomUUID(),
        a.accountId,
        a.providerId,
        entry.id,
        now,
        now,
      );
    }
  }

  return exists
    ? { id: entry.id, outcome: 'merged', password: addPassword, accounts, skippedAccounts }
    : { id: entry.id, outcome: 'created', password: addPassword, accounts, skippedAccounts, emailVerified: entry.emailVerified ?? null };
}
