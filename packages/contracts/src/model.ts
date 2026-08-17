/**
 * The entity registry (#697).
 *
 * The manifest describes permissions, events, guards, schedules, attachment
 * targets, entity relations, searchables and UI contributions. It does not
 * describe **entities**: `migrations` is a pointer (`journalDir` +
 * `compatibleFrom`), the tables live in raw SQL the manifest never sees, and
 * entity *type names* appear only as bare `z.string().min(1)` fragments across
 * four unrelated, individually optional features.
 *
 * Nothing checks those four against each other or against the tables. A typo'd
 * `parentType` in `entityRelations` parses cleanly and produces an edge that
 * permission never flows along — the tuple evaluator walks a relation that does
 * not exist, and a grant that should reach a child silently does not.
 *
 * This module gives them something to be checked against.
 *
 * ## What it is not
 *
 * Migrations do not move in here, and nothing about how tables are created
 * changes. Whether the model becomes the source that migrations are *derived*
 * from is #680/#685's question; the registry is a prerequisite either way.
 */
import { z } from 'zod';

/**
 * One entity: the table it lives in, its field schema, and its place in the
 * permission graph.
 */
export interface EntityDef<Names extends string = string> {
  /** The physical table. Owned by this module — never another's (rule 4). */
  readonly table: string;
  /** The row shape. Field names are what `key`, `searchables` and events check against. */
  readonly fields: z.ZodObject<z.ZodRawShape>;
  /**
   * The parent entity types permission may flow along (design doc §4.2 rule 3).
   * Checked against the declared entities — a typo is a compile error, where it
   * used to be a silently dead edge.
   *
   * **Plural, and an array even for one.** `entityRelations` is an ALLOWLIST,
   * not an assertion: the kernel accumulates permitted parents into a *set* per
   * entity type and `ctx.link` checks membership. `reservation` already hangs
   * off both `resource` and `member`; `protocol` off both `workorder` and
   * `employee`. Singular `parent` said "the parent", which is not what the
   * kernel means and cannot express the real cases.
   */
  readonly parents?: readonly Names[];
  /** Natural key, if any. Must name fields that exist. */
  readonly key?: readonly string[];
  /** Fields an erasure must be able to reach (§12). Must name fields that exist. */
  readonly erasable?: readonly string[];
}

/** The field names of one entity, read off its own `fields` schema. */
export type EntityFields<E> = E extends { fields: infer F }
  ? F extends z.ZodObject<z.ZodRawShape>
    ? keyof z.infer<F> & string
    : never
  : never;

/**
 * Declare a module's entities.
 *
 * The constraint is self-referential — `parent` is checked against the map's own
 * keys, and `key`/`erasable` against each entity's own fields — which is what
 * makes the checks bite per-entity rather than as a union across all of them.
 * Written the obvious way (an erased supertype) every one of them compiles clean
 * and enforces nothing; see `test/model.test.ts`, which exists to prove they
 * still bite.
 */
export function defineEntities<
  T extends {
    readonly [K in keyof T]: EntityDef<keyof T & string> & {
      key?: readonly EntityFields<T[K]>[];
      erasable?: readonly EntityFields<T[K]>[];
    };
  },
>(entities: T): T {
  return entities;
}

/** The declared entity names. */
export type EntityName<T> = keyof T & string;

/**
 * The serialisable form — the artifact of record.
 *
 * Everything downstream (migrations, the manifest, the route table, an ER
 * diagram, a diff classifier) reads THIS, never the TypeScript. That is what
 * keeps the authoring notation swappable: a different authoring layer is a new
 * emitter writing the same JSON, and nothing downstream notices.
 *
 * Field schemas are rendered with `z.toJSONSchema`, the same conversion the
 * OpenAPI builder already uses — so there is no second schema language anywhere
 * in the pipeline.
 */
export interface EmittedEntity {
  readonly table: string;
  readonly fields: Record<string, unknown>;
  /** The permitted parent types, sorted. One shape, always. */
  readonly parents?: readonly string[];
  readonly key?: readonly string[];
  readonly erasable?: readonly string[];
}

export interface EmittedModel {
  readonly entities: Record<string, EmittedEntity>;
}

/**
 * Render the registry to plain JSON. Deterministic: entities and their fields
 * are emitted in sorted order, so the checked-in artifact diffs cleanly and a
 * reordered declaration is not a spurious change.
 */
export function emitModel<T extends Record<string, EntityDef>>(entities: T): EmittedModel {
  const out: Record<string, EmittedEntity> = {};
  for (const name of Object.keys(entities).sort()) {
    const e = entities[name];
    if (!e) continue;
    const { $schema: _drop, ...fields } = z.toJSONSchema(e.fields, { io: 'output', target: 'draft-2020-12' }) as Record<
      string,
      unknown
    >;
    out[name] = {
      table: e.table,
      fields,
      ...(e.parents?.length ? { parents: [...e.parents].sort() } : {}),
      ...(e.key ? { key: [...e.key].sort() } : {}),
      ...(e.erasable ? { erasable: [...e.erasable].sort() } : {}),
    };
  }
  return { entities: out };
}

/**
 * `entityRelations` derived from the `parent` declarations, rather than written
 * a second time by hand.
 *
 * Two descriptions of one fact is how they come to disagree — and the disagreement
 * here is invisible, because a relation naming an entity that does not exist is a
 * permission edge that silently never resolves.
 */
export function entityRelationsOf<T extends Record<string, EntityDef>>(
  entities: T,
): { entityType: string; parentType: string }[] {
  return Object.keys(entities)
    .sort()
    .flatMap((name) => {
      const parents = entities[name]?.parents;
      if (!parents?.length) return [];
      return [...parents].sort().map((parentType) => ({ entityType: name, parentType }));
    });
}

// ---------------------------------------------------------------------------
// The manifest, checked against the registry.
// ---------------------------------------------------------------------------

/**
 * The entity-referencing half of a manifest, narrowed to declared entities.
 *
 * Entity-name positions are written `keyof T & string` inline rather than as
 * `EntityName<T>`. A type ALIAS is printed unresolved in diagnostics — the error
 * names the alias and inlines the whole entity map — where the inline form lists
 * the actual names:
 *
 *     Type '"bkie"' is not assignable to type '"bike" | "customer"'.
 */
type EntityRefs<T extends Record<string, EntityDef>, M> = {
  readonly attachmentTargets?: readonly {
    readonly entityType: keyof T & string;
    readonly readPermission: string;
    readonly writePermission?: string;
  }[];
  /**
   * `fields` is checked against the NAMED entity's own fields — the only place
   * in the manifest today where a field name appears at all, and nothing
   * checked it.
   */
  readonly searchables?: M extends { searchables: infer S }
    ? {
        readonly [I in keyof S]: S[I] extends { entityType: infer N }
          ? N extends keyof T & string
            ? { readonly entityType: N; readonly fields: readonly EntityFields<T[N]>[] }
            : never
          : never;
      }
    : never;
  readonly entityViews?: readonly { readonly entityType: keyof T & string; readonly view: string }[];
  /**
   * The engine registries this module composes, so relation edges naming their
   * entities can be checked.
   */
  readonly engines?: readonly Record<string, EntityDef>[];
  /**
   * Parent edges involving an entity this module does not own.
   *
   * A vertical legitimately declares these: an engine is entity-agnostic, so
   * only the vertical knows that a work order hangs off a bike, or a protocol
   * off a work order. **Both sides are checked** against the local entities plus
   * every entity of every registry in `engines`.
   *
   * Local-to-local edges do not belong here — they are DERIVED from the
   * entities' own `parents`, and declaring one twice is how two descriptions of
   * a fact come to disagree.
   *
   * This replaces the `foreignChildOf` / `foreignChildren` pair, which existed
   * only because foreign names were uncheckable. They are now, so the split has
   * nothing left to say.
   */
  readonly relations?: readonly {
    // Inlined rather than via a `ComposedName<T, M>` alias: TypeScript prints an
    // alias UNRESOLVED, so the diagnostic would name the alias and dump the
    // whole entity map instead of listing the names (learned in #705).
    readonly entityType: (keyof T & string) | (M extends { engines: readonly (infer R)[] } ? NamesOf<R> : never);
    readonly parentType: (keyof T & string) | (M extends { engines: readonly (infer R)[] } ? NamesOf<R> : never);
  }[];
};

/** Every entity name in one registry. */
type NamesOf<R> = R extends Record<string, EntityDef> ? keyof R & string : never;


/**
 * Compose the entity-referencing manifest fragments against the registry.
 *
 * `entityRelations` is absent by design: it is DERIVED from the entities'
 * `parent` declarations (`entityRelationsOf`) rather than written a second time.
 *
 * Spread the result into the module's manifest:
 *
 * ```ts
 * export const manifest = moduleManifest.parse({
 *   id: '@acme/vertical',
 *   …,
 *   ...manifestEntities(entities, {
 *     attachmentTargets: [{ entityType: 'contract', readPermission: 'x:read' }],
 *     searchables: [{ entityType: 'customer', fields: ['name'] }],
 *   }),
 * });
 * ```
 *
 * A typo in any `entityType` is now a compile error naming the declared
 * entities, and a `searchables` field that the entity does not have is too.
 */
export function manifestEntities<
  const T extends Record<string, EntityDef>,
  const M extends EntityRefs<T, M>,
>(
  entities: T,
  refs: M,
): {
  attachmentTargets: NonNullable<M['attachmentTargets']> | [];
  searchables: M['searchables'];
  entityRelations: { entityType: string; parentType: string }[];
  ui: { entityViews: M['entityViews'] };
} {
  return {
    attachmentTargets: (refs.attachmentTargets ?? []) as NonNullable<M['attachmentTargets']> | [],
    searchables: refs.searchables as M['searchables'],
    // Derived edges first, then the ones this module cannot check.
    // Local edges are derived from the entities' own `parents`; edges involving
    // a composed engine's entity are declared, and both sides are checked.
    entityRelations: [...entityRelationsOf(entities), ...(refs.relations ?? [])],
    ui: { entityViews: refs.entityViews as M['entityViews'] },
  };
}

/**
 * The row type of a declared entity — what `ctx.sql.query` returns for it.
 *
 * `ctx.sql.query` leaves `T` to the vertical, so every handler writes its own
 * row interface and the schema ends up described three times: the DDL, the
 * registry, and a hand-written `interface CustomerRow`. This collapses the
 * third into the second.
 *
 * ```ts
 * export type CustomerRow = EntityRow<typeof calloutEntities, 'customer'>;
 * ```
 */
export type EntityRow<T extends Record<string, EntityDef>, K extends keyof T> = T[K] extends {
  fields: infer F;
}
  ? F extends z.ZodObject<z.ZodRawShape>
    ? z.infer<F>
    : never
  : never;

/**
 * Column names per table, read out of a migration journal's SQL.
 *
 * **Test tooling**, exported because three engines had hand-rolled a copy and
 * the copies had already drifted — none followed `RENAME TO`, so a journal that
 * rebuilds a table under a temporary name would report the pre-rebuild columns
 * forever.
 *
 * It exists because a registry and a journal are two descriptions of one schema
 * until migrations are derived from the registry. Holding them to each other is
 * what keeps that duplication safe in the meantime.
 *
 * Handles what real journals do: multi-line `CHECK (...)` constraints (tracked
 * by paren depth, so a continuation line is not read as a column), `ADD COLUMN`,
 * `DROP TABLE`, and `RENAME TO` — append-only journals rebuild a table by
 * creating a `_new`, copying, dropping the original and renaming onto its name.
 */
export function journalColumns(sql: string): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();

  for (const [, table, body] of sql.matchAll(
    /CREATE TABLE (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\s*\);/gi,
  )) {
    if (!table || !body) continue;
    const cols = new Set<string>();
    let depth = 0;
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      const atTop = depth === 0;
      depth += (line.match(/\(/g) ?? []).length - (line.match(/\)/g) ?? []).length;
      if (!atTop) continue;
      if (!line || line.startsWith('--') || /^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(line)) continue;
      const name = /^([a-z_][a-z0-9_]*)\b/i.exec(line)?.[1];
      if (name) cols.add(name);
    }
    tables.set(table, cols);
  }

  // Replayed in statement order: a journal may add a column and later rename the
  // table, or rename onto a name it has just dropped.
  for (const m of sql.matchAll(
    /(?:ALTER TABLE ([a-z_][a-z0-9_]*)\s+ADD COLUMN\s+([a-z_][a-z0-9_]*))|(?:ALTER TABLE ([a-z_][a-z0-9_]*)\s+RENAME TO\s+([a-z_][a-z0-9_]*))|(?:DROP TABLE (?:IF EXISTS )?([a-z_][a-z0-9_]*))/gi,
  )) {
    const [, addTable, addCol, fromTable, toTable, dropped] = m;
    if (addTable && addCol) tables.get(addTable)?.add(addCol);
    else if (dropped) tables.delete(dropped);
    else if (fromTable && toTable) {
      const cols = tables.get(fromTable);
      if (cols) {
        tables.delete(fromTable);
        tables.set(toTable, cols);
      }
    }
  }
  return tables;
}
