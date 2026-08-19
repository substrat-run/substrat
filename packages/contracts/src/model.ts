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
  /**
   * The table's identity. Defaults to `['id']`.
   *
   * **Declared, because not every table's identity is an `id`.** The `vertical_`
   * side table keyed by an engine's id — the composition pattern the design
   * rules prescribe — has no id of its own to have, and inventing one would be
   * wrong: it would permit two side rows for one work order, which is the very
   * thing the primary key exists to prevent. Value-keyed tables are the same
   * shape: a counter per `(kind, year)`, a budget per `(customer, year, month)`.
   *
   * **Kept distinct from `key`, because SQL's own distinction is the useful
   * one.** `primaryKey` is identity; `key` is an additional uniqueness rule. A
   * table legitimately has both — a composite primary key and a separate
   * natural key — so reading `key` as the primary key when an entity has no
   * `id` would conflate two facts to save a field.
   *
   * Order is significant and preserved: a composite primary key is also the
   * index its columns are searched by, left to right.
   *
   * An entity with neither `primaryKey` nor an `id` field is an ERROR, not a
   * table without a primary key. That silence is what let 15 of one production
   * vertical's 63 tables emit with no primary key at all while a column-by-column
   * parity check reported 63/63 (#804).
   */
  readonly primaryKey?: readonly string[];
  /** Natural key, if any. Must name fields that exist. */
  readonly key?: readonly string[];
  /** Fields an erasure must be able to reach (§12). Must name fields that exist. */
  readonly erasable?: readonly string[];
  /**
   * Fields that used to be called something else — `{ current: previous }`.
   *
   * **The one thing a migration diff cannot derive.** A diff sees a field gone
   * and a field arrived and cannot tell a rename from a drop-plus-add; guessing
   * wrong drops the column and the data in it. So this is declared, and it is
   * the ONLY declaration in the journal that is not derived — everything else,
   * including the version number, comes from the diff.
   *
   * **Deletable after use.** It exists to survive one diff, not forever. Once
   * the rename has shipped, the old name is gone from the journal and the entry
   * becomes a no-op that can be removed. A model that accumulates these is
   * carrying gravestones.
   */
  readonly renamedFrom?: Readonly<Record<string, string>>;
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
      primaryKey?: readonly EntityFields<T[K]>[];
      key?: readonly EntityFields<T[K]>[];
      erasable?: readonly EntityFields<T[K]>[];
      // Keys are CURRENT field names — the thing being renamed TO. The values
      // are historical and name nothing that still exists, so they stay strings.
      //
      // The key is checked by the MIGRATION PLANNER, not here: TypeScript does
      // not apply excess-property checking when satisfying a generic
      // constraint, so an unknown key widens rather than erroring. Written the
      // obvious way this reads like a working check and enforces nothing —
      // which is worse than no check, so it is not claimed. `planMigration`
      // refuses a declaration naming a field the model does not have.
      renamedFrom?: Readonly<Partial<Record<EntityFields<T[K]>, string>>>;
    };
  },
>(entities: T): T {
  return entities;
}

/** The declared entity names. */
export type EntityName<T> = keyof T & string;

/**
 * The entity's primary key — declared, or `['id']` if it has an `id` field.
 *
 * Resolved in one place because two callers need the same answer and the same
 * refusal: the DDL emitter, which cannot write a `CREATE TABLE` without it, and
 * `emitModel`, so the artifact of record carries the fact rather than leaving it
 * to be re-derived by whoever reads it.
 *
 * **It throws rather than returning nothing.** A table with no primary key is
 * not a shape the model may express: it accepts duplicate rows silently, and a
 * parity check that compares columns — the natural one to write — reports a
 * perfect match over it (#804).
 */
export function primaryKeyOf(name: string, entity: EntityDef): readonly string[] {
  const shape = entity.fields.shape as Record<string, unknown>;
  const declared = entity.primaryKey;
  if (declared?.length) {
    for (const col of declared) {
      if (!(col in shape)) {
        throw new Error(`model: ${name}.primaryKey names '${col}', which is not a field`);
      }
    }
    if (new Set(declared).size !== declared.length) {
      throw new Error(`model: ${name}.primaryKey repeats a column — (${declared.join(', ')})`);
    }
    return declared;
  }
  if ('id' in shape) return ['id'];
  throw new Error(
    `model: ${name} has no 'id' field and declares no \`primaryKey\` — a table without a ` +
      'primary key accepts duplicate rows. Declare the columns that identify a row, e.g. ' +
      "`primaryKey: ['workorder_id']` for a side table keyed by an engine's id",
  );
}

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
  /**
   * Present only when it is not the `['id']` default, and **unsorted** — unlike
   * `key`, a primary key's column order is part of the fact, so sorting it for a
   * tidier diff would emit a different index than the one declared.
   */
  readonly primaryKey?: readonly string[];
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
      // Resolved, not just copied: this also refuses an entity with no identity
      // at all, so `lint:model --check` goes red on it the same way the DDL
      // emitter does.
      ...(primaryKeyOf(name, e).join() === 'id' ? {} : { primaryKey: primaryKeyOf(name, e) }),
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


/** Marker prefix on a JSON column's description. Read by the DDL emitter. */
export const JSON_COLUMN = 'substrat:json:';

/**
 * A column holding arbitrary JSON.
 *
 * Some columns genuinely hold a document — a requirement blob, a set of ids, a
 * geometry — and modelling their interior would be a second description of
 * something the vertical parses itself. A production vertical has 19 such fields
 * across 10 tables, which is what promoted this from "plausible" to real.
 *
 * The `because` is required, and that is the point: `z.unknown()` on its own is
 * still an ERROR to the emitter, so a JSON column can never appear because
 * somebody could not think of a type. Deliberately opaque and not-yet-modelled
 * have to be distinguishable, or the first quietly becomes cover for the second.
 *
 * Stored as TEXT — SQLite has no JSON type, only functions over TEXT.
 */
export function jsonColumn(because: string): z.ZodType {
  if (!because.trim()) throw new Error('jsonColumn(because) needs a reason — that is what it is for');
  return z.unknown().describe(`${JSON_COLUMN}${because}`);
}
