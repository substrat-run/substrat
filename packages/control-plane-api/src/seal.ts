/**
 * Per-subject sealing of a scope dump on its way into a platform-retained copy (#37).
 *
 * The sibling of [`mask.ts`](./mask.ts), and the contrast is the point. Masking is for a
 * copy a HUMAN will read: lossy, heuristic, irreversible, and applied when data leaves the
 * governed environment. Sealing is for a copy the PLATFORM keeps: lossless, keyed, and
 * reversible — right up until the subject's key is destroyed, after which it is more
 * irreversible than masking ever was.
 *
 * **Why a backup needs this at all.** Reap backups and stored dumps are full-fidelity on
 * purpose (`backups.ts`: *"a backup that cannot restore is a false promise"*), which is
 * exactly why an erasure cannot reach one. `UPDATE … SET payload = NULL` erases the live
 * scope; it does nothing to the copy sitting in R2 from last Tuesday. Sealing each
 * subject's payloads under their own key on the way out means destroying that one key
 * reaches backwards into every copy already taken — which is the only mechanism that makes
 * "erased" true of an immutable store.
 *
 * **Scope is narrow and deliberate.** Only `_substrat_outbox`, only rows the kernel has
 * already classified (`pii_class != 'none'` with a `subject_id`), only the `payload` cell.
 * The envelope stays readable so a restored copy is still navigable, and vertical-owned
 * tables are untouched — a vertical's own PII is a documented limit of this mechanism, not
 * something quietly half-covered here (see kernel-design.md, open question 17).
 */

import type { ScopeDumpTable } from '@substrat-run/contracts';
import type { SealedSecret } from '@substrat-run/kernel';

/**
 * The key operations both directions need, as `HostAdmin` exposes them. Narrowed to an
 * interface so this module can be tested without a host, and so the seal path cannot reach
 * for any other admin capability.
 */
export interface SubjectSealer {
  seal(
    items: readonly { subjectId: string; plaintext: string }[],
  ): Promise<(SealedSecret | null)[]>;
  open(items: readonly { subjectId: string; sealed: SealedSecret }[]): Promise<(string | null)[]>;
}

/**
 * The wrapper written into a sealed cell.
 *
 * Self-describing rather than a side manifest: the cell says it is sealed and names the key
 * that opens it, so a restore needs nothing but the dump and the key store. A manifest
 * would be one more thing to lose, and losing it would make an otherwise-restorable backup
 * unreadable.
 */
interface SealedCell {
  __sealed: SealedSecret;
}

const SPINE_TABLE = '_substrat_outbox';

const isSealedCell = (value: unknown): value is SealedCell =>
  typeof value === 'object' &&
  value !== null &&
  '__sealed' in value &&
  typeof (value as SealedCell).__sealed?.ciphertext === 'string';

/** Parse a cell that may already be a sealed envelope; anything else reads as "not sealed". */
function readSealed(cell: unknown): SealedSecret | undefined {
  if (typeof cell !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(cell);
    return isSealedCell(parsed) ? parsed.__sealed : undefined;
  } catch {
    return undefined;
  }
}

/** Locate the spine table and the three columns that drive both directions. */
function spineColumns(
  tables: ScopeDumpTable[],
): { index: number; subject: number; pii: number; payload: number } | undefined {
  const index = tables.findIndex((t) => t.name === SPINE_TABLE);
  if (index < 0) return undefined;
  const table = tables[index]!;
  const subject = table.columns.indexOf('subject_id');
  const pii = table.columns.indexOf('pii_class');
  const payload = table.columns.indexOf('payload');
  // A dump from before any of these columns existed is left entirely alone rather than
  // half-processed — the honest answer for a copy the classification never reached.
  if (subject < 0 || pii < 0 || payload < 0) return undefined;
  return { index, subject, pii, payload };
}

/** Rows this pass should act on, as (row index, subject id) pairs. */
function classifiedRows(
  table: ScopeDumpTable,
  cols: { subject: number; pii: number; payload: number },
): { row: number; subjectId: string }[] {
  const out: { row: number; subjectId: string }[] = [];
  table.rows.forEach((row, i) => {
    const subjectId = row[cols.subject];
    const piiClass = row[cols.pii];
    if (typeof subjectId !== 'string' || subjectId === '') return;
    if (piiClass === 'none' || typeof piiClass !== 'string') return;
    if (row[cols.payload] === null || row[cols.payload] === undefined) return;
    out.push({ row: i, subjectId });
  });
  return out;
}

/**
 * Seal every classified payload in a dump. Returns new arrays; never mutates the input.
 *
 * A payload whose subject has been shredded seals to `null` — the sealer refuses to mint a
 * key for a tombstoned subject, and the copy records the same absence a live redaction
 * leaves. A cell that is ALREADY sealed passes through untouched, so re-sealing a dump
 * (a backup of a backup, a retried capture) is a no-op rather than double encryption.
 */
export async function sealDump(
  tables: ScopeDumpTable[],
  sealer: SubjectSealer,
): Promise<ScopeDumpTable[]> {
  const cols = spineColumns(tables);
  if (!cols) return tables;
  const table = tables[cols.index]!;
  const targets = classifiedRows(table, cols).filter(
    (t) => readSealed(table.rows[t.row]![cols.payload]) === undefined,
  );
  if (targets.length === 0) return tables;

  const sealed = await sealer.seal(
    targets.map((t) => ({
      subjectId: t.subjectId,
      // Cells are SQLite text; a non-string payload would be a corrupt spine row, and
      // String() keeps that from throwing mid-backup.
      plaintext: String(table.rows[t.row]![cols.payload]),
    })),
  );

  const rows = table.rows.map((row) => [...row]);
  targets.forEach((t, i) => {
    const result = sealed[i];
    rows[t.row]![cols.payload] = result ? JSON.stringify({ __sealed: result }) : null;
  });
  return tables.map((t, i) => (i === cols.index ? { ...t, rows } : t));
}

/**
 * Open every sealed payload in a dump — the restore half.
 *
 * A payload whose key is gone opens to `null`. That is where an erasure actually bites: the
 * ciphertext was in the backup all along, and after the shred nothing turns it back into a
 * person. The restored scope then looks exactly like a live scope that was redacted, which
 * is the property worth having — two copies of the same tenant that disagree about who was
 * erased is the failure this shape avoids.
 *
 * Unsealed cells pass through, so a dump taken before sealing existed still restores.
 */
export async function openDump(
  tables: ScopeDumpTable[],
  sealer: SubjectSealer,
): Promise<ScopeDumpTable[]> {
  const cols = spineColumns(tables);
  if (!cols) return tables;
  const table = tables[cols.index]!;
  const targets: { row: number; subjectId: string; sealed: SealedSecret }[] = [];
  for (const t of classifiedRows(table, cols)) {
    const sealed = readSealed(table.rows[t.row]![cols.payload]);
    if (sealed) targets.push({ ...t, sealed });
  }
  if (targets.length === 0) return tables;

  const opened = await sealer.open(
    targets.map((t) => ({ subjectId: t.subjectId, sealed: t.sealed })),
  );

  const rows = table.rows.map((row) => [...row]);
  targets.forEach((t, i) => {
    rows[t.row]![cols.payload] = opened[i] ?? null;
  });
  return tables.map((t, i) => (i === cols.index ? { ...t, rows } : t));
}
