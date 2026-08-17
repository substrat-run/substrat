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
   * The parent entity permission flows along (design doc §4.2 rule 3).
   * Checked against the declared entities — a typo is a compile error, where
   * today it is a silently dead edge.
   */
  readonly parent?: Names;
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
  readonly parent?: string;
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
      ...(e.parent ? { parent: e.parent } : {}),
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
      const parent = entities[name]?.parent;
      return parent ? [{ entityType: name, parentType: parent }] : [];
    });
}

// ---------------------------------------------------------------------------
// The manifest, checked against the registry.
// ---------------------------------------------------------------------------

/** The entity-referencing half of a manifest, narrowed to declared entities. */
type EntityRefs<T extends Record<string, EntityDef>, M> = {
  readonly attachmentTargets?: readonly {
    readonly entityType: EntityName<T>;
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
          ? N extends EntityName<T>
            ? { readonly entityType: N; readonly fields: readonly EntityFields<T[N]>[] }
            : never
          : never;
      }
    : never;
  readonly entityViews?: readonly { readonly entityType: EntityName<T>; readonly view: string }[];
};

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
    entityRelations: entityRelationsOf(entities),
    ui: { entityViews: refs.entityViews as M['entityViews'] },
  };
}
