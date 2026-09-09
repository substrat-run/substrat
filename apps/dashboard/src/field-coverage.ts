import type { DeclaredOperationOutput, EmittedModel } from '@substrat-run/contracts';

/**
 * One declared field, and whether anything is declared to return it (#1321).
 *
 * The claim is deliberately about DECLARATIONS, not behaviour: "no operation
 * declares this field in its output" is exactly and verifiably true from the two
 * artifacts a push carries, where "nobody reads this" would be a claim about
 * traffic that only counting could support (#1331).
 */
export interface FieldCoverageRow {
  field: string;
  /** Named by at least one operation's declared output. */
  returned: boolean;
  /** Declared erasable — personal data an erasure must be able to reach (§12). */
  erasable: boolean;
}

export interface EntityCoverage {
  entity: string;
  table: string;
  fields: FieldCoverageRow[];
  /** Fields no operation declares — the removal candidates, in declaration order. */
  neverReturned: FieldCoverageRow[];
}

export interface FieldCoverageView {
  /**
   * False when the running version carries no `outputSurface` — pushed before the
   * CLI emitted one. THE load-bearing flag: without the surface every field is
   * unnamed, so a view that rendered anyway would report an app's entire schema as
   * dead. Unknown must never be dressed as a finding.
   */
  available: boolean;
  entities: EntityCoverage[];
  /** Totals across entities, for the one-line summary. */
  declared: number;
  returned: number;
  /** Never-returned fields that are also erasable — a retention argument, not just cleanup. */
  neverReturnedErasable: number;
  /** Operations whose declared output contributed names. */
  operations: number;
}

/**
 * Join the emitted model against the declared output surface (#1321): which
 * declared fields is anything even capable of returning?
 *
 * Matching is by field NAME across the whole surface, which makes the
 * never-returned list CONSERVATIVE: a name shared between entities (`id`,
 * `created_at`) counts as returned everywhere it appears, so a field on this list
 * is certainly named nowhere, while a field absent from it may still be
 * unreachable in practice. Under-reporting is the safe direction for a list whose
 * whole purpose is to justify deleting something.
 */
export function deriveFieldCoverage(input: {
  model: EmittedModel | null;
  /** Null = the running version predates the surface — unknown, not empty. */
  outputSurface: DeclaredOperationOutput[] | null;
}): FieldCoverageView {
  const { model, outputSurface } = input;
  const empty: FieldCoverageView = {
    available: false,
    entities: [],
    declared: 0,
    returned: 0,
    neverReturnedErasable: 0,
    operations: 0,
  };
  if (!model || outputSurface === null) return empty;

  const named = new Set<string>();
  for (const op of outputSurface) for (const f of op.fields) named.add(f);

  const entities: EntityCoverage[] = [];
  let declared = 0;
  let returned = 0;
  let neverReturnedErasable = 0;
  for (const [entity, def] of Object.entries(model.entities)) {
    const erasable = new Set(def.erasable ?? []);
    // The emitted field schema is JSON Schema: its `properties` are the declared
    // fields, in declaration order.
    const props = (def.fields as { properties?: Record<string, unknown> } | undefined)?.properties;
    const fields: FieldCoverageRow[] = Object.keys(props ?? {}).map((field) => ({
      field,
      returned: named.has(field),
      erasable: erasable.has(field),
    }));
    declared += fields.length;
    returned += fields.filter((f) => f.returned).length;
    const neverReturned = fields.filter((f) => !f.returned);
    neverReturnedErasable += neverReturned.filter((f) => f.erasable).length;
    entities.push({ entity, table: def.table, fields, neverReturned });
  }
  // Worst first: the entities with something to act on lead, then by size.
  entities.sort((a, b) =>
    b.neverReturned.length - a.neverReturned.length || a.entity.localeCompare(b.entity),
  );

  return {
    available: true,
    entities,
    declared,
    returned,
    neverReturnedErasable,
    operations: outputSurface.length,
  };
}
