/**
 * #707 — the operation surface, and proof its checks are enforced.
 *
 * The `@ts-expect-error` cases ARE the feature. A type-level constraint fails
 * *permissively*: route each operation through an erased supertype and every
 * check here compiles clean while enforcing nothing, which from the happy path
 * is indistinguishable from working. That happened five times building the
 * spike this is ported from, twice in code that looked shipped.
 *
 * If a check stops biting, tsc reports "Unused '@ts-expect-error' directive"
 * and `pnpm --filter @substrat-run/contracts typecheck` goes red.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineEntities } from '../src/model.js';
import { defineOperations, eventsEmittedBy, permissionsUsedBy } from '../src/operations.js';

const entities = defineEntities({
  customer: {
    table: 't_customer',
    fields: z.object({ id: z.string(), number: z.string(), name: z.string() }),
    erasable: ['name'],
  },
  contract: {
    table: 't_contract',
    fields: z.object({ id: z.string(), customer_id: z.string(), status: z.string() }),
    parent: 'customer',
  },
  /** Deliberately has a `name` that is NOT erasable — a company inbox, not a person. */
  office: { table: 't_office', fields: z.object({ id: z.string(), name: z.string() }) },
});

const PERMS = ['customer:manage', 'customer:amounts', 'contract:write'] as const;
const ops = defineOperations(entities, PERMS);

describe('operation surface', () => {
  const operations = ops({
    'customer/create': {
      summary: 'Register a customer',
      permission: 'customer:manage',
      input: z.object({ name: z.string() }),
      output: z.object({ id: z.string(), number: z.string() }),
      http: { method: 'POST', path: '/customers' },
      emits: {
        entity: 'customer',
        entityIdFrom: 'id',
        type: 'callout.customer-created',
        schemaVersion: 1,
        piiClass: 'none',
        payload: ['id', 'number'],
      },
    },
    // The #695 shape: a mutation writing a CHILD whose event is about the PARENT,
    // so the id field and the entity deliberately differ.
    'contract/open': {
      summary: 'Open a contract for a customer',
      permission: 'contract:write',
      input: z.object({ customerId: z.string() }),
      output: z.object({ contractId: z.string(), customer_id: z.string() }),
      emits: {
        entity: 'customer',
        entityIdFrom: 'customer_id',
        type: 'callout.contract-opened',
        schemaVersion: 1,
        piiClass: 'none',
      },
    },
    'customer/list': {
      summary: 'List the customers this caller may see',
      narrows: { reason: 'a salesperson sees their own customers, not a denial' },
      input: z.object({}),
      output: z.object({ rows: z.array(z.string()) }),
    },
  });

  it('collects the permissions the manifest must declare', () => {
    expect(permissionsUsedBy(operations)).toEqual(['contract:write', 'customer:manage']);
  });

  it('collects the events, deterministically', () => {
    expect(eventsEmittedBy(operations)).toEqual([
      { type: 'callout.contract-opened', schemaVersion: 1 },
      { type: 'callout.customer-created', schemaVersion: 1 },
    ]);
  });

  it('is a pass-through — the declaration is the value', () => {
    expect(Object.keys(operations)).toHaveLength(3);
  });
});

// --- authority: the permission must be DECLARED -----------------------------
ops({
  'x/do': {
    summary: 's',
    // @ts-expect-error 'customer:manag' is not a declared permission
    permission: 'customer:manag',
    input: z.object({}),
    output: z.object({ id: z.string() }),
  },
});

// --- authority: permission XOR narrows — never both -------------------------
ops({
  'x/do': {
    summary: 's',
    // @ts-expect-error narrows and a leading permission are mutually exclusive
    permission: 'customer:manage',
    input: z.object({}),
    output: z.object({ id: z.string() }),
    narrows: { reason: 'own rows' },
  },
});

// --- ...and never neither ---------------------------------------------------
ops({
  // @ts-expect-error neither permission nor narrows — rule 5 unenforced
  'x/do': {
    summary: 's',
    input: z.object({}),
    output: z.object({ id: z.string() }),
  },
});

// --- narrows must state a reason --------------------------------------------
ops({
  'x/do': {
    summary: 's',
    input: z.object({}),
    output: z.object({ id: z.string() }),
    // @ts-expect-error a bare `narrows: true` carries no reason
    narrows: true,
  },
});

// --- http: every {var} names an input field ---------------------------------
ops({
  'customer/get': {
    summary: 's',
    permission: 'customer:manage',
    input: z.object({ id: z.string() }),
    output: z.object({ id: z.string() }),
    // @ts-expect-error {customerId} is not an input field — the input has 'id'
    http: { method: 'GET', path: '/customers/{customerId}' },
  },
});

// --- events: entityIdFrom names an OUTPUT field (the #695 defect) -----------
ops({
  'contract/advance': {
    summary: 's',
    permission: 'contract:write',
    input: z.object({ contractId: z.string() }),
    output: z.object({ contractId: z.string(), status: z.string() }),
    emits: {
      entity: 'contract',
      // @ts-expect-error the output has no 'id' — it answers with contractId
      entityIdFrom: 'id',
      type: 'callout.contract-advanced',
      schemaVersion: 1,
      piiClass: 'none',
    },
  },
});

// --- events: the entity must be declared ------------------------------------
ops({
  'x/do': {
    summary: 's',
    permission: 'customer:manage',
    input: z.object({}),
    output: z.object({ id: z.string() }),
    emits: {
      // @ts-expect-error 'invoice' is not a declared entity
      entity: 'invoice',
      entityIdFrom: 'id',
      type: 'x.done',
      schemaVersion: 1,
      piiClass: 'none',
    },
  },
});

// --- events: piiClass other than 'none' REQUIRES a subjectId ----------------
ops({
  'x/do': {
    summary: 's',
    permission: 'customer:manage',
    input: z.object({}),
    output: z.object({ id: z.string() }),
    // @ts-expect-error piiClass 'direct' without a subjectId to key the erasure
    emits: {
      entity: 'customer',
      entityIdFrom: 'id',
      type: 'x.done',
      schemaVersion: 1,
      piiClass: 'direct',
    },
  },
});

// --- events: subjectId must name a real output field ------------------------
ops({
  'x/do': {
    summary: 's',
    permission: 'customer:manage',
    input: z.object({}),
    output: z.object({ id: z.string() }),
    emits: {
      entity: 'customer',
      entityIdFrom: 'id',
      type: 'x.done',
      schemaVersion: 1,
      piiClass: 'direct',
      // @ts-expect-error 'personId' is not a field of the output
      subjectId: 'personId',
    },
  },
});

// --- events: an erasable field cannot ride in the payload (§12) -------------
ops({
  'customer/create': {
    summary: 's',
    permission: 'customer:manage',
    input: z.object({}),
    output: z.object({ id: z.string(), name: z.string() }),
    emits: {
      entity: 'customer',
      entityIdFrom: 'id',
      type: 'callout.customer-created',
      schemaVersion: 1,
      piiClass: 'none',
      // @ts-expect-error 'name' is @erasable on customer — events outlive erasure
      payload: ['id', 'name'],
    },
  },
});

// --- ...but ONLY for the entity the event is about --------------------------
// `name` is erasable on customer and not on office. A name-matching check would
// refuse this; resolving through `emits.entity` accepts it, correctly.
ops({
  'office/register': {
    summary: 's',
    permission: 'customer:manage',
    input: z.object({}),
    output: z.object({ id: z.string(), name: z.string() }),
    emits: {
      entity: 'office',
      entityIdFrom: 'id',
      type: 'callout.office-registered',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'name'],
    },
  },
});

// --- gates: the field must be on the OUTPUT ---------------------------------
ops({
  'customer/get': {
    summary: 's',
    permission: 'customer:manage',
    input: z.object({}),
    output: z.object({ id: z.string(), amount: z.string() }),
    // @ts-expect-error 'amunt' is not a field of the output
    gates: { amunt: 'customer:amounts' },
  },
});

// --- gates: the permission must be declared ---------------------------------
ops({
  'customer/get': {
    summary: 's',
    permission: 'customer:manage',
    input: z.object({}),
    output: z.object({ id: z.string(), amount: z.string() }),
    // @ts-expect-error 'customer:amount' is not declared (typo for :amounts)
    gates: { amount: 'customer:amount' },
  },
});

// ---------------------------------------------------------------------------
// COMPOSED ENGINES — an event about an entity the ENGINE owns.
//
// Found by migrating a 159-operation production vertical: its
// `contract/checklist-toggle` emits about `protocol`, which belongs to
// engine-protocol. Neither reference demo caught it because neither emits any
// event at all (`emits: []` in both manifests) — so `emits.entity` had never
// been exercised against a real vertical.
// ---------------------------------------------------------------------------

/** Stands in for an engine's exported registry. */
const engineRegistry = defineEntities({
  protocol: {
    table: 'protocol_instances_v2',
    fields: z.object({ id: z.string(), instance_ref: z.string() }),
    erasable: ['instance_ref'],
  },
});

const composed = defineOperations(entities, PERMS, [engineRegistry]);

// The engine's entity resolves.
composed({
  'contract/checklist-toggle': {
    summary: 'Toggle a checklist item on a protocol instance',
    permission: 'customer:manage',
    input: z.object({ instanceId: z.string() }),
    output: z.object({ instanceId: z.string(), done: z.boolean() }),
    emits: {
      entity: 'protocol',
      entityIdFrom: 'instanceId',
      type: 'fsk.contract-checklist-toggled',
      schemaVersion: 1,
      piiClass: 'none',
    },
  },
});

// --- an entity that is neither ours nor a composed engine's -----------------
composed({
  'x/do': {
    summary: 's',
    permission: 'customer:manage',
    input: z.object({}),
    output: z.object({ id: z.string() }),
    emits: {
      // @ts-expect-error 'protocl' is neither a local entity nor a composed engine's
      entity: 'protocl',
      entityIdFrom: 'id',
      type: 'x.done',
      schemaVersion: 1,
      piiClass: 'none',
    },
  },
});

// --- an engine that is NOT composed contributes no names --------------------
ops({
  'x/do': {
    summary: 's',
    permission: 'customer:manage',
    input: z.object({}),
    output: z.object({ id: z.string() }),
    emits: {
      // @ts-expect-error `ops` was built without engines, so 'protocol' is unknown
      entity: 'protocol',
      entityIdFrom: 'id',
      type: 'x.done',
      schemaVersion: 1,
      piiClass: 'none',
    },
  },
});

// --- the ENGINE's erasable set governs a payload about the engine's entity --
composed({
  'x/do': {
    summary: 's',
    permission: 'customer:manage',
    input: z.object({}),
    output: z.object({ id: z.string(), instance_ref: z.string() }),
    emits: {
      entity: 'protocol',
      entityIdFrom: 'id',
      type: 'x.done',
      schemaVersion: 1,
      piiClass: 'none',
      // @ts-expect-error 'instance_ref' is @erasable on the ENGINE's protocol entity
      payload: ['id', 'instance_ref'],
    },
  },
});
