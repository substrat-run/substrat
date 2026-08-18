/**
 * DDL emitted from the entity registry — the first deterministic emitter
 * (model-phase-plan §9 step 2).
 *
 * Today every adopter hand-writes its `CREATE TABLE` and keeps a test holding it
 * to the registry. That test exists *because* the duplication does; deriving the
 * DDL is what deletes both.
 *
 * ## Reads the TypeScript, not `model.json`
 *
 * It walks the live Zod objects. `z.toJSONSchema` keeps declarative constraints
 * and silently drops `.refine()` and `.brand()`, so an emitter reading the JSON
 * would produce a schema weaker than the model declares.
 *
 * ## No silent defaults
 *
 * A Zod type this cannot map is an ERROR, never a guess. #695's 18 broken events
 * came from an emitter defaulting rather than refusing, applied uniformly and
 * silently — for anything reaching a migration, absent must be loud.
 */
import { z } from 'zod';
import { JSON_COLUMN, type EntityDef } from '@substrat-run/contracts';

/** What a column becomes, before nullability and constraints. */
interface Column {
  readonly name: string;
  readonly type: 'TEXT' | 'INTEGER' | 'REAL';
  readonly nullable: boolean;
  /** `status TEXT NOT NULL CHECK (status IN ('a','b'))` */
  readonly check?: string;
}

/** Unwrap the wrappers Zod puts around a base type, recording nullability. */
function peel(schema: z.ZodTypeAny): { inner: z.ZodTypeAny; nullable: boolean } {
  let s = schema;
  let nullable = false;
  // `.optional()` and `.nullable()` both mean "may be absent" in a row.
  for (;;) {
    const def = (s as { _def?: { typeName?: string; innerType?: z.ZodTypeAny } })._def;
    const t = def?.typeName ?? (s as { type?: string }).type;
    if ((t === 'ZodOptional' || t === 'ZodNullable' || t === 'optional' || t === 'nullable') && def?.innerType) {
      nullable = true;
      s = def.innerType;
      continue;
    }
    // Zod 4 keeps the wrapped schema on `.unwrap()` for these.
    const unwrap = (s as { unwrap?: () => z.ZodTypeAny }).unwrap;
    if (typeof unwrap === 'function' && (t === 'ZodOptional' || t === 'ZodNullable')) {
      nullable = true;
      s = unwrap.call(s);
      continue;
    }
    return { inner: s, nullable };
  }
}

function columnFor(name: string, schema: z.ZodTypeAny, where: string): Column {
  const { inner, nullable } = peel(schema);
  const kind = (inner as { type?: string }).type ?? (inner as { _def?: { typeName?: string } })._def?.typeName;

  if (kind === 'string' || kind === 'ZodString') return { name, type: 'TEXT', nullable };
  if (kind === 'boolean' || kind === 'ZodBoolean') return { name, type: 'INTEGER', nullable };
  if (kind === 'number' || kind === 'ZodNumber') {
    // Ints and reals both land in NUMERIC affinity; INTEGER is the honest
    // default for counts, and money is a string by platform rule (K-14).
    return { name, type: 'INTEGER', nullable };
  }
  if (kind === 'enum' || kind === 'ZodEnum') {
    const values = Object.values(
      (inner as { options?: readonly string[]; _def?: { values?: readonly string[] } }).options ??
        (inner as { _def?: { values?: readonly string[] } })._def?.values ??
        {},
    ) as string[];
    if (!values.length) throw new Error(`emit-sql: ${where} is an enum with no values`);
    const list = values.map((v) => `'${v.replace(/'/g, "''")}'`).join(',');
    return { name, type: 'TEXT', nullable, check: `CHECK (${name} IN (${list}))` };
  }

  // A column declared with `jsonColumn(because)` — deliberately opaque, stored
  // as TEXT because SQLite has no JSON type. A bare `z.unknown()` still falls
  // through to the error below, so opacity is always something someone chose.
  if ((inner as { description?: string }).description?.startsWith(JSON_COLUMN)) {
    return { name, type: 'TEXT', nullable };
  }

  // Refuse rather than guess. A column emitted from a shape this does not
  // understand is a migration nobody can reason about.
  throw new Error(
    `emit-sql: cannot map ${where} (zod kind '${String(kind)}') to a column — ` +
      `map it explicitly, or model the field as one this understands`,
  );
}

/**
 * Parents before children, alphabetical within a tier.
 *
 * Sorting by name alone emitted `todo_items` — which REFERENCES `todo_lists` —
 * first. SQLite tolerates a forward reference; a stricter engine does not, and
 * "it happened to work" is not a property to ship. Deterministic either way,
 * which is what lets the output be diffed.
 *
 * A cycle cannot be ordered, so it is reported rather than silently truncated:
 * remaining entities are appended in name order after the error names them.
 */
function tableOrder<T extends Record<string, EntityDef>>(entities: T): string[] {
  const names = Object.keys(entities).sort();
  const placed = new Set<string>();
  const out: string[] = [];

  let progress = true;
  while (progress && out.length < names.length) {
    progress = false;
    for (const name of names) {
      if (placed.has(name)) continue;
      const parents = entities[name]?.parents ?? [];
      // A parent outside this registry (a composed engine's entity) cannot be
      // emitted here and therefore cannot be waited for.
      const blocked = parents.some((p) => p in entities && !placed.has(String(p)));
      if (blocked) continue;
      placed.add(name);
      out.push(name);
      progress = true;
    }
  }

  if (out.length < names.length) {
    const cyclic = names.filter((n) => !placed.has(n));
    throw new Error(
      `emit-sql: parent cycle among ${cyclic.join(', ')} — a table cannot be created before itself`,
    );
  }
  return out;
}

export interface EmitSqlOptions {
  /** `IF NOT EXISTS`, for an emitter run against an existing database. */
  readonly ifNotExists?: boolean;
}

/**
 * `CREATE TABLE` for every declared entity, in sorted order.
 *
 * - `id` becomes `TEXT PRIMARY KEY NOT NULL`. The `NOT NULL` is deliberate and
 *   stricter than most hand-written schemas: in SQLite a non-INTEGER primary key
 *   does NOT imply it, so `id TEXT PRIMARY KEY` accepts a NULL id. Every
 *   `vertical_*` table written by hand in this repo has that hole.
 * - `key` becomes a `UNIQUE` constraint.
 * - `parents` becomes a `REFERENCES` clause per parent, on `<parent>_id` when the
 *   entity declares such a column — never invented if it does not.
 */
export function emitTables<T extends Record<string, EntityDef>>(
  entities: T,
  options: EmitSqlOptions = {},
): string {
  const exists = options.ifNotExists ? 'IF NOT EXISTS ' : '';
  const out: string[] = [];

  for (const name of tableOrder(entities)) {
    const entity = entities[name];
    if (!entity) continue;
    const cols = [
      ...columnsOf(name, entity, entities).map((c) => `  ${c.ddl}`),
      ...uniqueConstraints(name, entity).map((u) => `  ${u}`),
    ];
    out.push(`CREATE TABLE ${exists}${entity.table} (\n${cols.join(',\n')}\n);`);
  }

  return out.join('\n\n');
}

/** One emitted column: its name, its full definition, and whether SQLite could ADD it. */
export interface EmittedColumn {
  readonly name: string;
  /** `owner_id TEXT NOT NULL REFERENCES todo_owners(id)` */
  readonly ddl: string;
  /** NOT NULL with no default cannot be added to a table that already has rows. */
  readonly requiredWithoutDefault: boolean;
}

/**
 * The columns one entity emits, shared by `emitTables` and the migration
 * planner.
 *
 * Extracted rather than duplicated: the planner has to render a column the exact
 * way the table would have rendered it, or an `ALTER TABLE ADD COLUMN` produces
 * a schema subtly unlike the one a fresh `CREATE TABLE` would.
 */
export function columnsOf<T extends Record<string, EntityDef>>(
  name: string,
  entity: EntityDef,
  entities: T,
): EmittedColumn[] {
  const shape = entity.fields.shape as Record<string, z.ZodTypeAny>;
  const out: EmittedColumn[] = [];

  for (const [field, schema] of Object.entries(shape)) {
    const c = columnFor(field, schema, `${name}.${field}`);
    if (field === 'id') {
      out.push({ name: 'id', ddl: `id ${c.type} PRIMARY KEY NOT NULL`, requiredWithoutDefault: true });
      continue;
    }
    let ddl = `${c.name} ${c.type}`;
    if (!c.nullable) ddl += ' NOT NULL';
    if (c.check) ddl += ` ${c.check}`;
    // A parent edge whose id column is present becomes a real foreign key.
    for (const parent of entity.parents ?? []) {
      const parentTable = entities[parent as keyof T]?.table;
      if (parentTable && c.name === `${String(parent).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}_id`) {
        ddl += ` REFERENCES ${parentTable}(id)`;
      }
    }
    out.push({ name: c.name, ddl, requiredWithoutDefault: !c.nullable });
  }
  return out;
}

/** `UNIQUE (email)` per declared key field. */
export function uniqueConstraints(name: string, entity: EntityDef): string[] {
  const shape = entity.fields.shape as Record<string, z.ZodTypeAny>;
  return (entity.key ?? []).map((k) => {
    if (!(k in shape)) throw new Error(`emit-sql: ${name}.key names '${k}', which is not a field`);
    return `UNIQUE (${k})`;
  });
}
