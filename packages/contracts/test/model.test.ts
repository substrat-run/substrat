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
import { defineEntities, emitModel, entityRelationsOf, manifestEntities } from '../src/model.js';

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
manifestEntities(entities, {
  // @ts-expect-error 'custmer' is not a declared entity
  searchables: [{ entityType: 'custmer', fields: ['name'] }],
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
