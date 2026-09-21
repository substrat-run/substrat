import { actor, permissionKey, type Actor, type PermissionKey } from '@substrat-run/contracts';

/**
 * The tolerant decode of one spine row, field by field (#1588, #1636).
 *
 * Every spine read that returns a LIST used to decode its rows strictly, so one row
 * whose JSON would not parse threw out of the map and took every healthy neighbour
 * with it — the intent journal (#1588), an entity's history and its cause walks, the
 * denial log and its summary (#1636). The reads hit worst were the ones that exist to
 * explain a failure, switched off by exactly the row that failed.
 *
 * So each field is decoded against its OWN contract field, and a row says what did not
 * decode rather than taking the list down:
 *
 * - a JSON column that does not decode comes back EMPTY — the caller names the empty
 *   value, which must be one the field's schema accepts (`null`, or a self-naming marker
 *   such as {@link UNDECODED_ACTOR} for a field that cannot be null). Never the raw text:
 *   a raw payload would read as a string payload that was never sent.
 * - a nullable scalar that breaks its schema comes back `null`.
 * - a REQUIRED scalar has no honest empty value, so a row that breaks one cannot be the
 *   contract shape without lying. It is collected, and `finish` throws naming every
 *   column the row broke — the strict decode this replaced, kept for exactly the part it
 *   cannot honestly relax.
 *
 * **Every value a decoder built on this returns satisfies the published schema**, which
 * is #1634's review finding carried forward: a field is only ever replaced by a value its
 * own schema accepts, so a caller can trust the type it was handed. What did not decode
 * is named, by column, in `decodeError` — ABSENT on a row the kernel wrote, so a healthy
 * list reads exactly as it did before.
 *
 * The message never quotes the stored text. `JSON.parse`'s own message does, and for a
 * payload that is the event's content: copied into a dead letter or a sweep log it would
 * be personal data somewhere an erasure does not reach. The one exception is `marked`, for
 * a short identifier whose stored value IS the evidence (a denial's permission key): that
 * one is quoted, capped, on purpose.
 */

type FieldParse<T> =
  | { success: true; data: T }
  | { success: false; error: { issues: ReadonlyArray<{ message: string; path: ReadonlyArray<PropertyKey> }> } };

/** The one method a decoder needs from a contract field — any Zod schema has it. */
export interface Field<T> {
  safeParse(value: unknown): FieldParse<T>;
}

/**
 * What an actor reads as when the stored one did not decode. An actor is required and has
 * no empty value, so this is a marker that names itself rather than a plausible actor: a
 * guessed principal would be the one thing worse than admitting nobody can tell.
 */
export const UNDECODED_ACTOR: Actor = actor.parse({ system: 'undecodable' });

/**
 * What a denial's `permission` reads as when the stored key is not a permission key (#1636).
 *
 * Unlike the other required scalars, this one is reachable from LIVE module code rather than
 * only from a dump: nothing validates a checked key at runtime, so a module that casts a
 * malformed key into `ctx.check` is refused, and the refusal is recorded with that key. The
 * denial log is exactly where someone goes to find out why — so the row must not take the
 * list with it, and the bad key is the evidence: `marked` carries it, verbatim, in
 * `decodeError`, beside this self-naming marker.
 */
export const UNDECODED_PERMISSION: PermissionKey = permissionKey.parse('undecodable:permission');

/** How much of a stored scalar a `marked` field quotes back — a key, not a payload. */
const QUOTED_MAX = 200;

/** `column: message`, for the first issue a field's schema raised. */
export function issueOf(
  column: string,
  error: Extract<FieldParse<unknown>, { success: false }>['error'],
): string {
  const issue = error.issues[0];
  const at = issue && issue.path.length ? `.${issue.path.map(String).join('.')}` : '';
  return `${column}${at}: ${issue?.message ?? 'does not match the contract'}`;
}

/** The message a JSON column that does not parse is recorded with — never the text itself. */
export const NOT_JSON = 'not valid JSON';

export interface RowDecoder {
  /** A required scalar. A failure is held until `finish`, which throws — the value never escapes. */
  required<T>(column: string, field: Field<T>, stored: unknown): T;
  /** A nullable scalar: `null`, named in `decodeError`, when it breaks its schema. */
  nullable<T>(column: string, field: Field<T | null>, stored: unknown): T | null;
  /**
   * A required scalar with a self-naming `marker` to stand in for it — for the column whose
   * stored value is the EVIDENCE (a denial's permission key), so the row is returned rather
   * than thrown, and the value is quoted in `decodeError` rather than lost. `marker` must be
   * a value `field` accepts. Only for a short identifier, never for content: it is quoted.
   */
  marked<T>(column: string, field: Field<T>, stored: unknown, marker: T): T;
  /** A JSON column: `empty`, named in `decodeError`, when it does not parse or breaks its schema. */
  json<T>(column: string, field: Field<T>, stored: string | null, empty: T): T;
  /** Every column that did not decode, required or not — for a caller whose logic reads one. */
  readonly failed: ReadonlySet<string>;
  /**
   * The row, with `decodeError` naming every column that did not decode — or absent when
   * all did. Throws, naming every column, when a required scalar broke.
   */
  finish<R extends object>(decoded: R): R & { decodeError?: string };
}

/**
 * One row's decoder. `subject` names the row in a throw (`platform request row "01J…"`),
 * `contract` the shape it could not be read as. Every field is decoded before `finish`
 * reads the lists, so a message names every column that failed — not whichever one
 * happened to be reached first.
 */
export function rowDecoder(subject: string, contract: string): RowDecoder {
  const undecoded: string[] = [];
  const unreadable: string[] = [];
  const failed = new Set<string>();
  return {
    failed,
    required<T>(column: string, field: Field<T>, stored: unknown): T {
      const r = field.safeParse(stored);
      if (r.success) return r.data;
      unreadable.push(issueOf(column, r.error));
      failed.add(column);
      return undefined as never;
    },
    nullable<T>(column: string, field: Field<T | null>, stored: unknown): T | null {
      const r = field.safeParse(stored);
      if (r.success) return r.data;
      undecoded.push(issueOf(column, r.error));
      failed.add(column);
      return null;
    },
    marked<T>(column: string, field: Field<T>, stored: unknown, marker: T): T {
      const r = field.safeParse(stored);
      if (r.success) return r.data;
      const quoted = JSON.stringify(stored) ?? String(stored);
      undecoded.push(
        `${issueOf(column, r.error)} (stored ${quoted.length > QUOTED_MAX ? `${quoted.slice(0, QUOTED_MAX)}…` : quoted})`,
      );
      failed.add(column);
      return marker;
    },
    json<T>(column: string, field: Field<T>, stored: string | null, empty: T): T {
      let value: unknown = null;
      if (stored !== null) {
        try {
          value = JSON.parse(stored);
        } catch {
          undecoded.push(`${column}: ${NOT_JSON}`);
          failed.add(column);
          return empty;
        }
      }
      const r = field.safeParse(value);
      if (r.success) return r.data;
      undecoded.push(issueOf(column, r.error));
      failed.add(column);
      return empty;
    },
    finish<R extends object>(decoded: R): R & { decodeError?: string } {
      if (unreadable.length) {
        throw new Error(
          `${subject} cannot be read as a ${contract} — ${[...unreadable, ...undecoded].join('; ')}`,
        );
      }
      return undecoded.length ? { ...decoded, decodeError: undecoded.join('; ') } : decoded;
    },
  };
}
