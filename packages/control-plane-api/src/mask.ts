import type { ScopeDumpTable } from '@substrat-run/contracts';

/**
 * The default masking pass over a scope dump (preview-and-snapshots.md §6/§8).
 *
 * A `scope pull` moves real customer data out of the governed environment, so the
 * dump is masked BY DEFAULT and full fidelity is the explicit break-glass flag.
 * This is the GENERIC sweep — §10's open question 2 answered for v1: a name-based
 * column heuristic, with declarative per-vertical redaction rules as the later
 * refinement. Two rules:
 *
 * 1. A string cell in a column whose name matches the PII heuristic is replaced
 *    with `[masked]`. Non-strings (ids, counts, flags) pass through — the sweep
 *    targets free text, and ids are what make the copy debuggable at all.
 * 2. A string cell in a JSON-carrying column (`payload`, `detail`, `before`,
 *    `after`, `data`) that parses as JSON is swept RECURSIVELY by key with the
 *    same heuristic, then re-serialized — fat event payloads keep their shape
 *    (consumers and timelines stay debuggable) while the PII fields inside them
 *    are masked.
 *
 * Deliberately lossy and deliberately dumb: a heuristic sweep can miss a column
 * named `x7`, which is why the pull is ALSO staff-gated, audited, and
 * jurisdiction-checked — masking is one layer of §6's defense, not the gate.
 */

// Free-text/PII column names. `name` is included on purpose: entity names
// (customers, properties, contacts) are customer data even when they look benign.
//
// `external_id` earns its place from the platform's OWN schema (#36): an identity link's
// `externalId` is the provider's subject, which in practice is very often the person's
// email address — so a tenant export that swept only the obvious columns would hand out
// the one field most likely to name a human. It is the deliberately lossy direction of
// the trade: an opaque third-party id (a document ref, an upstream order number) gets
// masked too, which costs a masked pull some fidelity and costs a leak nothing.
const PII_COLUMN = /(^|_)(email|e?mail_address|phone|mobile|tel|address|street|city|postal|zip|ssn|personnummer|name|first_name|last_name|full_name|contact|external_id|note|notes|comment|comments|message|subject|body|description)($|_)/i;

// Columns that carry JSON documents worth sweeping by key rather than blanking.
const JSON_COLUMN = /(^|_)(payload|detail|details|data|before|after)($|_)/i;

const MASKED = '[masked]';

// Column names are snake_case but JSON payload keys are camelCase — normalize to
// snake before testing so `customerEmail` matches the same heuristic as `email`.
const matchesPii = (name: string): boolean =>
  PII_COLUMN.test(name.replace(/([a-z0-9])([A-Z])/g, '$1_$2'));

function maskJsonValue(value: unknown, keyMatched: boolean): unknown {
  if (typeof value === 'string') return keyMatched ? MASKED : value;
  if (Array.isArray(value)) return value.map((v) => maskJsonValue(v, keyMatched));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = maskJsonValue(v, keyMatched || matchesPii(k));
    }
    return out;
  }
  return value;
}

/** Mask one dump in place-shape (returns new arrays; never mutates the input). */
export function maskDump(tables: ScopeDumpTable[]): ScopeDumpTable[] {
  return tables.map((t) => {
    const piiCols = t.columns.map((c) => matchesPii(c));
    const jsonCols = t.columns.map((c) => JSON_COLUMN.test(c));
    if (!piiCols.some(Boolean) && !jsonCols.some(Boolean)) return t;
    const rows = t.rows.map((row) =>
      row.map((cell, i) => {
        if (typeof cell !== 'string') return cell;
        if (piiCols[i]) return MASKED;
        if (jsonCols[i]) {
          try {
            return JSON.stringify(maskJsonValue(JSON.parse(cell), false));
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
 * The same heuristic applied to plain JSON records — the directory half of a tenant
 * export (#36).
 *
 * A tenant export carries two kinds of thing: scope databases (table-shaped, masked by
 * `maskDump` above) and directory records (object-shaped — a tenant's display name, an
 * org's name, an identity link's external id, which is usually an email). Both halves
 * must be masked by the SAME rule, or the default-masked promise is only half true and
 * the leak is in the half nobody looked at.
 *
 * So this reuses `maskJsonValue` rather than growing a second heuristic: one PII column
 * list, one recursive sweep, two entry points. Ids and timestamps pass through — the
 * sweep targets free text, and ids are what keep an export intelligible.
 */
export function maskRecords<T>(records: readonly T[]): T[] {
  return records.map((r) => maskJsonValue(r, false) as T);
}
