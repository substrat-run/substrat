import type { ScopeDumpTable } from '@substrat-run/contracts';
import { MASKED, kindOf, type PiiKind, type Pseudonymizer } from './pseudonymize.js';

/**
 * The default masking pass over a scope dump (preview-and-snapshots.md §6/§8).
 *
 * A `scope pull` moves real customer data out of the governed environment, so the
 * dump is masked BY DEFAULT and full fidelity is the explicit break-glass flag.
 * This is the GENERIC sweep — §10's open question 2 answered for v1: a name-based
 * column heuristic, with declarative per-vertical redaction rules as the later
 * refinement. Two rules:
 *
 * 1. A string cell in a column whose name matches the PII heuristic is **pseudonymized**
 *    — replaced with a deterministic fake value of the same kind (#1034,
 *    `pseudonymize.ts`). Non-strings (ids, counts, flags) pass through — the sweep
 *    targets free text, and ids are what make the copy debuggable at all.
 * 2. A string cell in a JSON-carrying column (`payload`, `detail`, `before`,
 *    `after`, `data`) that parses as JSON is swept RECURSIVELY by key with the
 *    same heuristic, then re-serialized — fat event payloads keep their shape
 *    (consumers and timelines stay debuggable) while the PII fields inside them
 *    are pseudonymized.
 *
 * What changed with #1034 is only what the masked branch WRITES. It used to be the
 * literal `[masked]` in every cell, which made a pulled scope structurally valid and
 * factually useless — every screen read `[masked]`, so nobody could drive a preview,
 * a demo or a local repro from one. Now the same cell gets a plausible fake of the
 * right kind, deterministic per export, so the copy reads like a tenant. Free text and
 * national identifiers still get `[masked]`, for the reasons `pseudonymize.ts` states.
 *
 * The output is **pseudonymized, not anonymized**: rare combinations, amounts and dates
 * can still re-identify a subject. Nothing about the gate relaxes because the values now
 * look fake — a heuristic sweep can still miss a column named `x7`, which is why the pull
 * is ALSO staff-gated, audited, and jurisdiction-checked. Masking is one layer of §6's
 * defense, not the gate.
 */

// Columns that carry JSON documents worth sweeping by key rather than blanking.
const JSON_COLUMN = /(^|_)(payload|detail|details|data|before|after)($|_)/i;

/** What a sweep does with one PII string: collect it, or replace it. */
type Visit = (kind: PiiKind, original: string) => string;

function sweepJson(value: unknown, kind: PiiKind | undefined, visit: Visit): unknown {
  if (typeof value === 'string') return kind && value ? visit(kind, value) : value;
  if (Array.isArray(value)) return value.map((v) => sweepJson(v, kind, visit));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // The child's OWN key wins when it is recognised: in `{ contact: { email } }`,
      // `contact` reads as `person`, and inheriting that would render a full name into
      // a field a consumer parses as an email. The inherited kind is the fallback for
      // keys the heuristic does not classify — and for array elements, which have no
      // key of their own, so `{ email: [a, b] }` still sweeps both.
      out[k] = sweepJson(v, kindOf(k) ?? kind, visit);
    }
    return out;
  }
  return value;
}

function sweepTables(tables: ScopeDumpTable[], visit: Visit): ScopeDumpTable[] {
  return tables.map((t) => {
    const kinds = t.columns.map((c) => kindOf(c));
    const jsonCols = t.columns.map((c) => JSON_COLUMN.test(c));
    if (!kinds.some(Boolean) && !jsonCols.some(Boolean)) return t;
    const rows = t.rows.map((row) =>
      row.map((cell, i) => {
        if (typeof cell !== 'string' || cell === '') return cell;
        const kind = kinds[i];
        if (kind) return visit(kind, cell);
        if (jsonCols[i]) {
          try {
            return JSON.stringify(sweepJson(JSON.parse(cell), undefined, visit));
          } catch {
            return cell; // not JSON — leave it; the column heuristic did not claim it
          }
        }
        return cell;
      }),
    );
    return { ...t, rows };
  });
}

/**
 * Two passes rather than one, because HMAC is async and a dump is a lot of cells: the
 * first walk collects every distinct value the sweep would touch, one batch of digests
 * is computed, and the second walk substitutes. A customer's email quoted in two
 * hundred event payloads costs exactly one digest.
 */
const collector = (into: Set<string>): Visit => (kind, original) => {
  if (kind !== 'redact') into.add(original);
  return original;
};

/** Mask one dump in place-shape (returns new arrays; never mutates the input). */
export async function maskDump(
  tables: ScopeDumpTable[],
  mask: Pseudonymizer,
): Promise<ScopeDumpTable[]> {
  const values = new Set<string>();
  sweepTables(tables, collector(values));
  await mask.prepare(values);
  return sweepTables(tables, (kind, original) => mask.valueFor(kind, original));
}

/**
 * The same heuristic applied to plain JSON records — the directory half of a tenant
 * export (#36).
 *
 * A tenant export carries two kinds of thing: scope databases (table-shaped, masked by
 * `maskDump` above) and directory records (object-shaped — a tenant's display name, an
 * org's name, an identity link's external id, which is usually an email). Both halves
 * must be masked by the SAME rule, or the default-masked promise is only half true and
 * the leak is in the half nobody looked at.
 *
 * So this reuses `sweepJson` rather than growing a second heuristic: one PII column
 * list, one recursive sweep, one generator, two entry points. Ids and timestamps pass
 * through — the sweep targets free text, and ids are what keep an export intelligible.
 */
export async function maskRecords<T>(records: readonly T[], mask: Pseudonymizer): Promise<T[]> {
  const values = new Set<string>();
  const collect = collector(values);
  for (const r of records) sweepJson(r, undefined, collect);
  await mask.prepare(values);
  return records.map((r) => sweepJson(r, undefined, (k, o) => mask.valueFor(k, o)) as T);
}

export { MASKED };
