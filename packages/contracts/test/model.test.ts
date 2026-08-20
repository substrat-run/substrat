/**
 * #697 — the entity registry, and proof that its checks are enforced.
 *
 * The `@ts-expect-error` cases below ARE the feature. A type-level constraint
 * fails *permissively*: written the obvious way (routing each entity through an
 * erased supertype) every check here compiles clean and enforces nothing, which
 * from the happy path looks identical to working. If a check stops biting, `tsc`
 * reports "Unused '@ts-expect-error' directive" and
 * `pnpm --filter @substrat-run/contracts typecheck` goes red.
 *
 * That gate is why this package gained a `tsconfig.test.json` — `tsconfig.json`
 * includes only `src`, so nothing in `test/` was typechecked before.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineEntities, emitModel, entityRelationsOf, manifestEntities, primaryKeyOf } from '../src/model.js';
import { defineOperations } from '../src/operations.js';

const entities = defineEntities({
  customer: {
    table: 'vertical_customer',
    fields: z.object({ id: z.string(), customerNumber: z.string(), name: z.string() }),
    key: ['customerNumber'],
    erasable: ['name'],
  },
  contract: {
    table: 'vertical_contract',
    fields: z.object({ id: z.string(), customerId: z.string(), status: z.string() }),
    parents: ['customer'],
  },
});

/**
 * #804 — a table whose identity is not an `id`.
 *
 * The first two are the `vertical_` side table keyed by an engine's id, which
 * the design rules prescribe: its identity IS the work order's, and giving it an
 * `id` of its own would permit two side rows for one work order. The third is an
 * ordinary value-keyed table.
 */
const keyedEntities = defineEntities({
  budget: {
    table: 'vertical_time_budget',
    fields: z.object({
      customer_id: z.string(),
      year: z.number(),
      month: z.number(),
      hours: z.string(),
    }),
    primaryKey: ['customer_id', 'year', 'month'],
  },
  ext: {
    table: 'vertical_workorder_ext',
    fields: z.object({ workorder_id: z.string(), route_note: z.string().nullable() }),
    primaryKey: ['workorder_id'],
  },
});

describe('primaryKeyOf', () => {
  it('defaults to id', () => {
    expect(primaryKeyOf('customer', entities.customer)).toEqual(['id']);
  });

  it('takes the declared key when there is one', () => {
    expect(primaryKeyOf('budget', keyedEntities.budget)).toEqual(['customer_id', 'year', 'month']);
    expect(primaryKeyOf('ext', keyedEntities.ext)).toEqual(['workorder_id']);
  });

  it('refuses an entity with no id and no declared key, rather than none at all', () => {
    // The silent case: a table with no primary key accepts duplicate rows, and a
    // parity check that compares columns reports a perfect match over it.
    const orphan = { table: 't', fields: z.object({ a: z.string(), b: z.string() }) };
    expect(() => primaryKeyOf('orphan', orphan)).toThrow(/no 'id' field and declares no `primaryKey`/);
  });

  it('refuses a key naming a field that does not exist', () => {
    const wrong = { table: 't', fields: z.object({ a: z.string() }), primaryKey: ['b'] };
    expect(() => primaryKeyOf('wrong', wrong)).toThrow(/names 'b', which is not a field/);
  });

  it('refuses a key that repeats a column', () => {
    const dupe = { table: 't', fields: z.object({ a: z.string(), b: z.string() }), primaryKey: ['a', 'a'] };
    expect(() => primaryKeyOf('dupe', dupe)).toThrow(/repeats a column/);
  });
});

describe('entity registry', () => {
  it('derives entityRelations from parent declarations', () => {
    // Not written a second time by hand: two descriptions of one fact is how
    // they come to disagree, and here the disagreement is a dead permission edge.
    expect(entityRelationsOf(entities)).toEqual([{ entityType: 'contract', parentType: 'customer' }]);
  });

  it('emits a deterministic artifact of record', () => {
    const a = emitModel(entities);
    const b = emitModel(entities);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(Object.keys(a.entities)).toEqual(['contract', 'customer']);
    expect(a.entities.customer?.table).toBe('vertical_customer');
    expect(a.entities.contract?.parents).toEqual(['customer']);
    // Field schemas travel as JSON Schema — the same conversion the OpenAPI
    // builder uses, so there is no second schema language in the pipeline.
    expect(a.entities.customer?.fields).toMatchObject({ type: 'object' });
  });

  it('carries a non-default primary key into the artifact, unsorted', () => {
    const m = emitModel(keyedEntities);
    // Unsorted: a composite primary key is the index its columns are searched
    // by, so sorting it for a tidier diff would emit a different table.
    expect(m.entities.budget?.primaryKey).toEqual(['customer_id', 'year', 'month']);
    expect(m.entities.ext?.primaryKey).toEqual(['workorder_id']);
  });

  it('leaves the artifact unchanged for the id default', () => {
    // Absent means `['id']`. Emitting it everywhere would churn every checked-in
    // model.json to restate the default.
    expect(emitModel(entities).entities.customer).not.toHaveProperty('primaryKey');
  });

  it('refuses to emit an entity that has no identity at all', () => {
    // `lint:model --check` goes red on it, the same way the DDL emitter does.
    const orphans = { thing: { table: 't_thing', fields: z.object({ a: z.string() }) } };
    expect(() => emitModel(orphans)).toThrow(/no 'id' field and declares no `primaryKey`/);
  });

  it('sorts entities and their key/erasable lists, so the diff is stable', () => {
    const reordered = defineEntities({
      contract: { table: 'vertical_contract', fields: z.object({ id: z.string() }) },
      customer: { table: 'vertical_customer', fields: z.object({ id: z.string() }) },
    });
    const forwards = defineEntities({
      customer: { table: 'vertical_customer', fields: z.object({ id: z.string() }) },
      contract: { table: 'vertical_contract', fields: z.object({ id: z.string() }) },
    });
    expect(JSON.stringify(emitModel(reordered))).toBe(JSON.stringify(emitModel(forwards)));
  });

  it('composes the entity-referencing manifest fragments', () => {
    const fragment = manifestEntities(entities, {
      attachmentTargets: [{ entityType: 'contract', readPermission: 'x:read' }],
      searchables: [{ entityType: 'customer', fields: ['name', 'customerNumber'] }],
      entityViews: [{ entityType: 'contract', view: './ui/ContractCard' }],
    });
    expect(fragment.entityRelations).toEqual([{ entityType: 'contract', parentType: 'customer' }]);
    expect(fragment.attachmentTargets).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// THE DEFECT THIS EXISTS FOR. A typo'd parent parses cleanly today and produces
// an edge permission never flows along — the tuple evaluator walks a relation
// that does not exist, and a grant that should reach a child silently does not.
// ---------------------------------------------------------------------------
defineEntities({
  customer: { table: 't_customer', fields: z.object({ id: z.string() }) },
  contract: {
    table: 't_contract',
    fields: z.object({ id: z.string() }),
    // @ts-expect-error 'custmer' is not a declared entity
    parents: ['custmer'],
  },
});

// --- key must name fields that exist on THIS entity -------------------------
defineEntities({
  customer: {
    table: 't_customer',
    fields: z.object({ id: z.string(), customerNumber: z.string() }),
    // @ts-expect-error 'custmerNumber' is not a field of customer
    key: ['custmerNumber'],
  },
});

// --- erasable likewise ------------------------------------------------------
defineEntities({
  customer: {
    table: 't_customer',
    fields: z.object({ id: z.string(), name: z.string() }),
    // @ts-expect-error 'emial' is not a field of customer
    erasable: ['emial'],
  },
});

// --- primaryKey is checked against the entity's own fields ------------------
defineEntities({
  budget: {
    table: 't_budget',
    fields: z.object({ customer_id: z.string(), year: z.number() }),
    // @ts-expect-error 'moth' is not a field of budget
    primaryKey: ['customer_id', 'moth'],
  },
});

// --- per-entity, not a union across all of them -----------------------------
// `name` exists on customer and NOT on contract. A union-shaped check would
// wrongly accept this; the self-referential constraint refuses it.
defineEntities({
  customer: { table: 't_customer', fields: z.object({ id: z.string(), name: z.string() }) },
  contract: {
    table: 't_contract',
    fields: z.object({ id: z.string(), status: z.string() }),
    // @ts-expect-error 'name' is a field of customer, not of contract
    key: ['name'],
  },
});

// ---------------------------------------------------------------------------
// POINTABILITY (#804 follow-up) — a composite key means no single id, so the
// entity cannot be pointed AT. Five positions, five inlined copies of the same
// mapped type; each has a case here, so a copy that stops biting turns its
// directive unused and fails `pnpm --filter @substrat-run/contracts typecheck`.
//
// The diagnostic is the point. Inlined it reads
//   Type '"budget"' is not assignable to type '"customer" | "ext"'.
// Aliased it dumps the whole entity map (#705), which is why these are inline.
// ---------------------------------------------------------------------------

const mixedKeys = defineEntities({
  customer: { table: 't_customer', fields: z.object({ id: z.string(), name: z.string() }) },
  // Single-column and NOT `id` — still pointable: it has one id, just not named `id`.
  ext: {
    table: 't_workorder_ext',
    fields: z.object({ workorder_id: z.string(), note: z.string() }),
    primaryKey: ['workorder_id'],
  },
  // Composite — no one id to be pointed at by.
  budget: {
    table: 't_budget',
    fields: z.object({ customer_id: z.string(), year: z.number(), hours: z.string() }),
    primaryKey: ['customer_id', 'year'],
  },
});

// --- a single-column key that is not `id` stays fully usable ----------------
manifestEntities(mixedKeys, {
  attachmentTargets: [{ entityType: 'ext', readPermission: 'x:read' }],
  entityViews: [{ entityType: 'ext', view: './ui/Ext' }],
});

// --- 1. `parents` — permission flows by ctx.link, which joins two EntityRefs -
defineEntities({
  budget: {
    table: 't_budget',
    fields: z.object({ customer_id: z.string(), year: z.number() }),
    primaryKey: ['customer_id', 'year'],
  },
  note: {
    table: 't_note',
    fields: z.object({ id: z.string(), text: z.string() }),
    // @ts-expect-error 'budget' is keyed by (customer_id, year) — a link joins two entity ids
    parents: ['budget'],
  },
});

// --- 2. attachmentTargets — an attachment hangs off one entity id -----------
manifestEntities(mixedKeys, {
  // @ts-expect-error 'budget' has no single id for an attachment to hang off
  attachmentTargets: [{ entityType: 'budget', readPermission: 'x:read' }],
});

// --- 3 & 4. relations — BOTH ends of a link ---------------------------------
manifestEntities(mixedKeys, {
  // @ts-expect-error 'budget' cannot be the CHILD of a link
  relations: [{ entityType: 'budget', parentType: 'customer' }],
});
manifestEntities(mixedKeys, {
  // @ts-expect-error 'budget' cannot be the PARENT of a link
  relations: [{ entityType: 'customer', parentType: 'budget' }],
});

// --- 5. emits.entity — an event is about one entity, named by one id field --
defineOperations(mixedKeys, ['budget:manage'] as const)({
  'acme/set-budget': {
    summary: 'Set a budget',
    permission: 'budget:manage',
    input: z.object({ customer_id: z.string(), year: z.number(), hours: z.string() }),
    output: mixedKeys.budget.fields,
    emits: {
      // @ts-expect-error 'budget' is composite — `entityIdFrom` would name a third of a row
      entity: 'budget',
      entityIdFrom: 'customer_id',
      type: 'acme.budget-set',
      schemaVersion: 1,
      piiClass: 'none',
    },
  },
});

// --- 6. a narrowed permission check — a grant against ONE entity id ---------
defineOperations(mixedKeys, ['budget:manage'] as const)({
  'acme/read-budget': {
    summary: 'Read a budget',
    permission: {
      key: 'budget:manage',
      // @ts-expect-error 'budget' is composite — a grant cannot narrow to a third of a row
      entity: 'budget',
      idFrom: 'customer_id',
    },
    input: z.object({ customer_id: z.string() }),
    output: mixedKeys.budget.fields,
  },
});

// --- attachmentTargets must name a declared entity --------------------------
manifestEntities(entities, {
  // @ts-expect-error 'invoice' is not a declared entity
  attachmentTargets: [{ entityType: 'invoice', readPermission: 'x:read' }],
});

// --- ui.entityViews likewise ------------------------------------------------
manifestEntities(entities, {
  // @ts-expect-error 'contrct' is not a declared entity
  entityViews: [{ entityType: 'contrct', view: './ui/Card' }],
});

// --- searchables: the entity name ------------------------------------------
// Inside a `toThrow`, unlike its neighbours: since #827 the enrichment READS the
// named entity (for its table and id column), so a typo is refused at runtime as
// well as rejected by the compiler. Both halves matter — the type check is what a
// vertical author sees, the throw is what a hand-written manifest hits.
describe('searchables', () => {
  it('refuses an entity name the registry does not have, at runtime too', () => {
    expect(() =>
      manifestEntities(entities, {
        // @ts-expect-error 'custmer' is not a declared entity
        searchables: [{ entityType: 'custmer', fields: ['name'] }],
      }),
    ).toThrow(/not a declared entity/);
  });

  it('carries the table and id column across from the registry', () => {
    expect(manifestEntities(entities, { searchables: [{ entityType: 'customer', fields: ['name'] }] }).searchables).toEqual([
      { entityType: 'customer', fields: ['name'], table: 'vertical_customer', idColumn: 'id' },
    ]);
  });

  it('refuses a composite-keyed entity, which has no single id to return', () => {
    expect(() =>
      manifestEntities(mixedKeys, {
        // @ts-expect-error `budget` is keyed by three columns, so it is not pointable
        searchables: [{ entityType: 'budget', fields: ['hours'] }],
      }),
    ).toThrow(/cannot be searchable/);
  });
});

// --- searchables: the FIELDS, against that entity's own schema --------------
// The only place a field name appears in the manifest today, and nothing
// checked it.
manifestEntities(entities, {
  // @ts-expect-error 'naem' is not a field of customer
  searchables: [{ entityType: 'customer', fields: ['naem'] }],
});

// --- and per-entity here too ------------------------------------------------
manifestEntities(entities, {
  // @ts-expect-error 'status' is a field of contract, not of customer
  searchables: [{ entityType: 'customer', fields: ['status'] }],
});

// ---------------------------------------------------------------------------
// FOREIGN RELATIONS — both sides checked against local + composed engines.
// This replaced the foreignChildOf/foreignChildren pair, which existed only
// because foreign names could not be checked.
// ---------------------------------------------------------------------------

/** Stands in for an engine's exported registry. */
const engineEntities = defineEntities({
  workorder: { table: 'workorder_orders', fields: z.object({ id: z.string() }) },
});

// The mixed edge — foreign child, local parent. Both names resolve.
manifestEntities(entities, {
  engines: [engineEntities],
  relations: [{ entityType: 'workorder', parentType: 'customer' }],
});

// --- the CHILD must resolve -------------------------------------------------
manifestEntities(entities, {
  engines: [engineEntities],
  // @ts-expect-error 'workordr' is neither a local entity nor a composed engine's
  relations: [{ entityType: 'workordr', parentType: 'customer' }],
});

// --- the PARENT must resolve ------------------------------------------------
manifestEntities(entities, {
  engines: [engineEntities],
  // @ts-expect-error 'custmer' is neither a local entity nor a composed engine's
  relations: [{ entityType: 'workorder', parentType: 'custmer' }],
});

// --- an engine that is NOT composed contributes no names --------------------
manifestEntities(entities, {
  // @ts-expect-error engineEntities is not in `engines`, so 'workorder' is unknown
  relations: [{ entityType: 'workorder', parentType: 'customer' }],
});
