/**
 * The observed half of field coverage (#1331): which of an operation's DECLARED output
 * fields a response actually carried.
 *
 * The declared half ships on the deploy manifest (#1321) — every field anything is capable
 * of returning. What it cannot say is which of them a caller ever receives, and the answer
 * has to be taken on the hot path, per response, because that is the only place it exists.
 * So the walk is built to cost as little as the question allows:
 *
 * - **O(declared fields), never O(response).** It iterates the declaration and asks the
 *   response about each name; it never enumerates the response's own keys. A result with a
 *   million keys, or rows nested ten deep, costs the same as one with three.
 * - **Top level only.** A declared field is a top-level property of the output (the same
 *   reading the declared half takes from `openapi.json`), so there is no recursion to bound.
 * - **One entry per list.** A paged read's or an array output's entries are homogeneous by
 *   schema, so the first entry answers for the page.
 * - **Capped.** At most `DECLARED_OUTPUT_FIELDS_MAX` declared names, the declared half's own cap.
 * - **Off unless armed** (`FIELD_COVERAGE_BINDING`), and resolved once per route at mount.
 *
 * ## What it records, and what it never does
 *
 * Names, and only names the DECLARATION supplies. A value is tested against `undefined` and
 * nothing else; it is never copied, stringified or measured. A response key the declaration
 * does not name is never recorded at all, because a key can be data — a map keyed by email
 * address is still a map.
 */
import { DECLARED_OUTPUT_FIELDS_MAX, isPage } from '@substrat-run/contracts';
import type { OutputFieldsReport } from '@substrat-run/kernel';
import { defOf, transparentInner } from './zod-structural.js';

/** How a response is walked: the names to ask about, and whether its first entry answers. */
export interface OutputWalk {
  readonly fields: readonly string[];
  /** The declared output is a list (an array, or a paged read's entry schema). */
  readonly list: boolean;
  /** Declared `paged`: the result is a `Page` whose entries are the list. */
  readonly paged: boolean;
}

/**
 * The declared output's top-level field names, read once at mount. `undefined` when the
 * declaration names none — no `output`, a scalar, a union — and then no route pays anything.
 *
 * Unions are skipped for the reason `coercerFor` skips them: two shapes have no single field
 * list, and guessing one would count a field as absent that the other shape never had.
 */
export function outputWalkOf(output: unknown, paged: boolean): OutputWalk | undefined {
  let schema = output;
  let list = paged;
  // A bound because a bound is cheap, not because a Zod schema can cycle.
  for (let depth = 0; depth < 8; depth++) {
    const def = defOf(schema);
    if (def?.type === 'object') {
      const shape = (schema as { shape?: unknown }).shape ?? def.shape;
      const names = shape && typeof shape === 'object' ? Object.keys(shape).slice(0, DECLARED_OUTPUT_FIELDS_MAX) : [];
      return names.length > 0 ? { fields: names, list, paged } : undefined;
    }
    if (def?.type === 'array') {
      // One level of list only: a list of lists has no fields of its own to count.
      if (list) return undefined;
      list = true;
      schema = def.element;
      continue;
    }
    // A pipe in an OUTPUT schema stops the walk. Its input is what the handler returns, but
    // its output is what the declaration (and the declared half, from OpenAPI) describes,
    // and a transform between the two can rename or reshape anything. Neither side is safe
    // to count against the other, so the operation declares no walkable fields.
    if (def?.type === 'pipe') return undefined;
    schema = transparentInner(def);
    if (schema === undefined) return undefined;
  }
  return undefined;
}

/**
 * Walk one operation result. `undefined` when there is nothing to observe — a result that is
 * not an object, or an empty list — so an unobserved response never counts a field absent.
 *
 * Never throws: a result whose property read throws (a Proxy, a hostile getter) is simply
 * not observed, and the request carries on to whatever its serialisation makes of it.
 */
export function observeOutputFields(result: unknown, walk: OutputWalk): OutputFieldsReport | undefined {
  try {
    let subject: unknown = result;
    if (walk.list) {
      // A paged read answers a `Page`; one whose handler has not adopted `pageOf` yet still
      // answers a bare array, and is walked the same way — the mount's own `isPage` test.
      const entries = walk.paged && isPage(subject) ? subject.entries : subject;
      if (!Array.isArray(entries) || entries.length === 0) return undefined;
      subject = entries[0];
    }
    if (subject === null || typeof subject !== 'object' || Array.isArray(subject)) return undefined;
    const row = subject as Record<string, unknown>;
    const present: string[] = [];
    const empty: string[] = [];
    const absent: string[] = [];
    for (const field of walk.fields) {
      // Own ENUMERABLE properties only, which is what `JSON.stringify` serialises, and
      // `undefined` is what it drops, so "present" and "empty" both mean "on the wire".
      // Read through the descriptor rather than `row[field]`, so an inherited getter never
      // runs, and neither does a Proxy's `get`. An own accessor is on the wire too, but its
      // value is not the walk's to compute, so it counts as present without being called.
      // `null` is its own bucket: a column that is always null is on the wire and still
      // never carries anything.
      const desc = Object.getOwnPropertyDescriptor(row, field);
      if (!desc || !desc.enumerable) absent.push(field);
      else if (!('value' in desc)) present.push(field);
      else if (desc.value === undefined) absent.push(field);
      else if (desc.value === null) empty.push(field);
      else present.push(field);
    }
    return { present, empty, absent };
  } catch {
    return undefined;
  }
}
