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
import {
  defineEngineRoutes,
  defineOperations,
  eventsEmittedBy,
  operationInputsOf,
  peersDeclaredBy,
  permissionsUsedBy,
} from '../src/operations.js';

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
  /** A remote's error text: not a person's, so not erasable — and still not for an event. */
  source: {
    table: 't_source',
    fields: z.object({ id: z.string(), url: z.string(), last_error: z.string() }),
    outsideText: ['last_error'],
  },
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
      narrows: { reason: 'a salesperson sees their own customers, not a denial', checks: ['customer:manage'] },
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
    narrows: { reason: 'own rows', checks: [] },
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

// --- an entity-narrowed check names what it narrows to ----------------------
ops({
  'customer/rename': {
    summary: 's',
    permission: { key: 'customer:manage', entity: 'customer', idFrom: 'customerId' },
    input: z.object({ customerId: z.string(), name: z.string() }),
    output: z.object({ id: z.string() }),
  },
});

// --- ...and `idFrom` must name an input field -------------------------------
ops({
  'customer/rename': {
    summary: 's',
    // @ts-expect-error 'custId' is not a field of this operation's input
    permission: { key: 'customer:manage', entity: 'customer', idFrom: 'custId' },
    input: z.object({ customerId: z.string(), name: z.string() }),
    output: z.object({ id: z.string() }),
  },
});

// --- ...and `entity` must name a declared entity ----------------------------
ops({
  'customer/rename': {
    summary: 's',
    // @ts-expect-error 'custumer' is not a declared entity
    permission: { key: 'customer:manage', entity: 'custumer', idFrom: 'customerId' },
    input: z.object({ customerId: z.string(), name: z.string() }),
    output: z.object({ id: z.string() }),
  },
});

// --- a check the handler must resolve says so, with a reason ----------------
ops({
  'customer/touch': {
    summary: 's',
    permission: { key: 'customer:manage', entity: 'customer', resolved: 'the site’s customer' },
    input: z.object({ siteId: z.string() }),
    output: z.object({ id: z.string() }),
  },
});

// --- ...but never both, and never neither -----------------------------------
ops({
  'customer/touch': {
    summary: 's',
    // @ts-expect-error idFrom and resolved are mutually exclusive
    permission: { key: 'customer:manage', entity: 'customer', idFrom: 'siteId', resolved: 'both' },
    input: z.object({ siteId: z.string() }),
    output: z.object({ id: z.string() }),
  },
});

ops({
  'customer/touch': {
    summary: 's',
    // @ts-expect-error neither idFrom nor resolved — the check says nothing about which entity
    permission: { key: 'customer:manage', entity: 'customer' },
    input: z.object({ siteId: z.string() }),
    output: z.object({ id: z.string() }),
  },
});

// --- narrows must state which of THIS module's keys the walk checks ---------
ops({
  'x/do': {
    summary: 's',
    input: z.object({}),
    output: z.object({ id: z.string() }),
    // @ts-expect-error `checks` is required — a key reached only by a walk would
    // otherwise vanish from the derived permission list
    narrows: { reason: 'own rows' },
  },
});

// --- ...and `checks` names declared keys, not free strings ------------------
ops({
  'x/do': {
    summary: 's',
    input: z.object({}),
    output: z.object({ id: z.string() }),
    // @ts-expect-error 'customer:manag' is not a declared permission key
    narrows: { reason: 'own rows', checks: ['customer:manag'] },
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

// --- http: PUT is a declarable method (#777) --------------------------------
ops({
  'customer/replace': {
    summary: 's',
    permission: 'customer:manage',
    input: z.object({ id: z.string(), name: z.string() }),
    output: z.object({ id: z.string() }),
    http: { method: 'PUT', path: '/customers/{id}' },
  },
});

describe('PATCH input declarations', () => {
  const update = (input: z.ZodObject<z.ZodRawShape>, patchException?: string) =>
    ops({
      'customer/update': {
        summary: 'Update a customer',
        permission: 'customer:manage',
        input,
        output: entities.customer.fields,
        http: { method: 'PATCH', path: '/customers/{id}' },
        ...(patchException === undefined ? {} : { patchException }),
      },
    });

  it('accepts optional, default-free body fields and a required path key', () => {
    expect(() => update(z.object({ id: z.string(), name: z.string().nullable().optional() }))).not.toThrow();
  });

  it('refuses a full replacement behind PATCH and names the remedy', () => {
    expect(() => update(z.object({ id: z.string(), name: z.string(), status: z.string().default('lead') })))
      .toThrow(/customer\/update.*name.*route it as PUT, make the field optional without a default, or declare patchException with a reason/);
  });

  it('refuses defaults and prefaults even inside optional wrappers', () => {
    expect(() => update(z.object({ id: z.string(), name: z.string().default('new').optional() })))
      .toThrow(/customer\/update.*name.*default/);
    expect(() => update(z.object({ id: z.string(), name: z.string().prefault('new').nullable().optional() })))
      .toThrow(/customer\/update.*name.*default/);
    let deeplyWrapped: z.ZodType = z.string().default('new');
    for (let i = 0; i < 20; i++) deeplyWrapped = deeplyWrapped.optional();
    expect(() => update(z.object({ id: z.string(), name: deeplyWrapped })))
      .toThrow(/customer\/update.*name.*default/);
  });

  it('finds and refuses defaults inside lazy schemas', () => {
    const name = z.lazy(() => z.string().default('x')).optional();
    expect(name.parse(undefined)).toBe('x');
    expect(() => update(z.object({ id: z.string(), name }))).toThrow(/customer\/update.*name.*default/);
  });

  it('finds and refuses defaults in nested object shapes', () => {
    const details = z.object({ child: z.string().default('x') }).optional();
    expect(details.parse({})).toEqual({ child: 'x' });
    expect(() => update(z.object({ id: z.string(), details }))).toThrow(/customer\/update.*details.*default/);
  });

  it('finds and refuses defaults in array elements', () => {
    const values = z.array(z.string().default('x')).optional();
    expect(values.parse([undefined])).toEqual(['x']);
    expect(() => update(z.object({ id: z.string(), values }))).toThrow(/customer\/update.*values.*default/);
  });

  it('finds and refuses defaults in record values', () => {
    const values = z.record(z.string(), z.string().default('x')).optional();
    expect(values.parse({ key: undefined })).toEqual({ key: 'x' });
    expect(() => update(z.object({ id: z.string(), values }))).toThrow(/customer\/update.*values.*default/);
  });

  it('finds and refuses defaults in union options', () => {
    const choice = z.union([
      z.object({ kind: z.literal('a'), child: z.string().default('x') }),
      z.object({ kind: z.literal('b') }),
    ]).optional();
    expect(choice.parse({ kind: 'a' })).toEqual({ kind: 'a', child: 'x' });
    expect(() => update(z.object({ id: z.string(), choice }))).toThrow(/customer\/update.*choice.*default/);
  });

  it('finds and refuses defaults in discriminated union options', () => {
    const choice = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a'), child: z.string().default('x') }),
      z.object({ kind: z.literal('b') }),
    ]).optional();
    expect(choice.parse({ kind: 'a' })).toEqual({ kind: 'a', child: 'x' });
    expect(() => update(z.object({ id: z.string(), choice }))).toThrow(/customer\/update.*choice.*default/);
  });

  it('refuses schema kinds it cannot inspect', () => {
    const opaque = { _zod: { def: { type: 'future_schema_kind' } } } as unknown as z.ZodType;
    expect(() => update(z.object({ id: z.string(), opaque })))
      .toThrow(/customer\/update.*opaque.*uninspectable Zod schema kind 'future_schema_kind'/);
  });

  it('refuses codecs that can produce a value for an omitted field', () => {
    const value = z.codec(z.object({}), z.object({ value: z.string().default('x') }), {
      decode: () => ({ value: 'x' }),
      encode: () => ({}),
    }).optional();
    expect(value.parse({})).toEqual({ value: 'x' });
    expect(() => update(z.object({ id: z.string(), value })))
      .toThrow(/customer\/update.*value.*uninspectable Zod schema kind 'pipe transform'/);
  });

  it('refuses overwrite checks that add a value to a parsed object', () => {
    const value = z.object({ value: z.string().optional() })
      .overwrite((input) => ({ ...input, value: 'x' }))
      .optional();
    expect(value.parse({})).toEqual({ value: 'x' });
    expect(() => update(z.object({ id: z.string(), value })))
      .toThrow(/customer\/update.*value.*uninspectable Zod schema kind 'overwrite'/);
  });

  it('accepts a reasoned exception, but not an empty reason', () => {
    expect(() => update(z.object({ id: z.string(), name: z.string() }), 'The handler writes only name.'))
      .not.toThrow();
    expect(() => update(z.object({ id: z.string(), name: z.string() }), '  '))
      .toThrow(/customer\/update.*patchException without a reason/);
  });

  it('allows full replacement through PUT', () => {
    expect(() => ops({
      'customer/update': {
        summary: 'Replace a customer',
        permission: 'customer:manage',
        input: z.object({ id: z.string(), name: z.string(), status: z.string().default('lead') }),
        output: entities.customer.fields,
        http: { method: 'PUT', path: '/customers/{id}' },
      },
    })).not.toThrow();
  });

  it('checks an engine operation when its route is bound to PATCH', () => {
    const engine = ops({
      'customer/update': {
        summary: 'Update a customer',
        permission: 'customer:manage',
        input: z.object({ id: z.string(), name: z.string() }),
        output: entities.customer.fields,
      },
    });
    expect(() => defineEngineRoutes(engine)({
      'customer/update': { method: 'PATCH', path: '/customers/{id}' },
    })).toThrow(/customer\/update.*name.*route it as PUT/);
    expect(() => defineEngineRoutes(engine)({
      'customer/update': { method: 'PUT', path: '/customers/{id}' },
    })).not.toThrow();
  });
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

// --- an outsideText field cannot ride either (#1088) --------------------------
ops({
  'source/fail': {
    summary: 's',
    permission: 'customer:manage',
    input: z.object({}),
    output: z.object({ id: z.string(), url: z.string(), last_error: z.string() }),
    emits: {
      entity: 'source',
      entityIdFrom: 'id',
      type: 'x.source-failed',
      schemaVersion: 1,
      piiClass: 'none',
      // @ts-expect-error 'last_error' is outsideText on source — an event outlives the row's cleanup
      payload: ['id', 'url', 'last_error'],
    },
  },
});
// ...and the same event without it is fine: the marker refuses one field, not the event.
ops({
  'source/fail': {
    summary: 's',
    permission: 'customer:manage',
    input: z.object({}),
    output: z.object({ id: z.string(), url: z.string(), last_error: z.string() }),
    emits: {
      entity: 'source',
      entityIdFrom: 'id',
      type: 'x.source-failed',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'url'],
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

/**
 * `peersDeclaredBy` (#1706) — the `peers` a module declares, derived from the operations
 * each peer may invoke rather than written beside them.
 *
 * The failure it exists to prevent is silent in the worst direction: a peer allowlisted for
 * an operation whose key it was not given is refused at that operation *every time*, and the
 * refusal looks exactly like the door working. Reading the keys off the operations makes the
 * two halves one fact; the throws below are what stop a hand-written list re-introducing the
 * gap.
 */
describe('peersDeclaredBy (#1706)', () => {
  const operations = ops({
    'customer/create': {
      summary: 'Register a customer',
      permission: 'customer:manage',
      input: z.object({ name: z.string() }),
      output: z.object({ id: z.string() }),
    },
    'contract/open': {
      summary: 'Open a contract',
      permission: 'contract:write',
      input: z.object({ customerId: z.string() }),
      output: z.object({ contractId: z.string() }),
    },
    'customer/list': {
      summary: 'List customers',
      narrows: { reason: 'a salesperson sees their own', checks: ['customer:manage'] },
      input: z.object({}),
      output: z.object({ rows: z.array(z.string()) }),
    },
  });

  it('derives each peer’s keys from the operations it may invoke', () => {
    expect(
      peersDeclaredBy(operations, {
        'acme/board-room': ['customer/list', 'customer/create'],
      }),
    ).toEqual({
      peers: [
        {
          vertical: 'acme/board-room',
          // Sorted, so the artifact of record is deterministic.
          operations: ['customer/create', 'customer/list'],
          // Read off those two operations — an entity-narrowed check counts, exactly as it
          // does for this module's own surface.
          permissions: ['customer:manage'],
        },
      ],
    });
  });

  it('is deterministic across peers, and derives each one independently', () => {
    const { peers } = peersDeclaredBy(operations, {
      'acme/ledger': ['contract/open'],
      'acme/board-room': ['customer/list'],
    });
    expect(peers.map((p) => p.vertical)).toEqual(['acme/board-room', 'acme/ledger']);
    expect(peers.map((p) => p.permissions)).toEqual([['customer:manage'], ['contract:write']]);
  });

  it('a receive-only peer (#1705) states its keys, since it has no operations to read them from', () => {
    expect(peersDeclaredBy(operations, { 'acme/ledger': { permissions: ['customer:manage'] } })).toEqual({
      peers: [{ vertical: 'acme/ledger', operations: [], permissions: ['customer:manage'] }],
    });
  });

  it('refuses a receive-only peer that states nothing — the contract requires a key', () => {
    expect(() => peersDeclaredBy(operations, { 'acme/ledger': [] })).toThrow(/names no operation and no permissions/);
    expect(() => peersDeclaredBy(operations, { 'acme/ledger': {} })).toThrow(/names no operation and no permissions/);
  });

  it('refuses an operation this module does not declare', () => {
    expect(() =>
      // @ts-expect-error — not a key of this module's operations, which is the point
      peersDeclaredBy(operations, { 'acme/board-room': ['customer/invent'] }),
    ).toThrow(/does not declare/);
  });

  it('refuses a stated key set that omits one its own allowlisted operations check', () => {
    // The whole reason the keys are derived: this peer may call `contract/open`, which checks
    // `contract:write`, and would be refused there on every call while the declaration looked
    // deliberate. An explicit list may add, never silently subtract.
    expect(() =>
      peersDeclaredBy(operations, {
        'acme/board-room': { operations: ['contract/open'], permissions: ['customer:manage'] },
      }),
    ).toThrow(/would be refused at its own allowlisted calls/);
  });

  it('a stated key set may be WIDER than the operations need', () => {
    // Legitimate: a peer that also receives events (#1705) needs the export's key, which no
    // operation of its own checks.
    expect(
      peersDeclaredBy(operations, {
        'acme/board-room': { operations: ['contract/open'], permissions: ['contract:write', 'customer:manage'] },
      }).peers[0]!.permissions,
    ).toEqual(['contract:write', 'customer:manage']);
  });

  it('refuses a peer that would hold nothing at all — the last line, below the compiler', () => {
    // `defineOperations` already refuses an operation that checks nothing, so reaching this
    // needs a cast. The guard stays because the artifact it protects (`peerSpec`) requires at
    // least one key, and a peer holding none is a declaration that can only ever be refused —
    // a clear message here beats a schema error two layers down. The cast is what pins it.
    const noCheck = { 'ping/run': { summary: 'ping' } } as unknown as Record<string, object>;
    expect(() => peersDeclaredBy(noCheck, { 'acme/board-room': ['ping/run'] })).toThrow(
      /would hold no permission/,
    );
  });
});

/** #2001 (K-44): the declared `order` is what a caller naming none gets, on every door. */
describe('operationInputsOf: a paged read’s declared order', () => {
  const inputs = operationInputsOf({
    'acme/newest': {
      input: z.object({ status: z.string().optional() }),
      paged: { over: { entity: 'customer', sortable: ['created_at'] }, order: 'desc' },
    },
    'acme/oldest': { paged: { over: { entity: 'customer', sortable: ['created_at'] }, order: 'asc' } },
    'acme/undeclared': { paged: { sortKey: 'id' } },
  });
  const parse = (name: string, value: unknown) => inputs[name]!.parse(value) as Record<string, unknown>;

  it('defaults to the declaration when the caller names no order', () => {
    expect(parse('acme/newest', { limit: 2 })).toEqual({ limit: 2, order: 'desc' });
    expect(parse('acme/oldest', {})).toEqual({ order: 'asc' });
  });

  it('defaults an in-process call that passes no input at all', () => {
    expect(parse('acme/newest', undefined)).toEqual({ order: 'desc' });
  });

  it('lets an explicit order win', () => {
    expect(parse('acme/newest', { order: 'asc' })).toEqual({ order: 'asc' });
  });

  it('leaves order absent where nothing declares one, so a handler’s own fallback decides', () => {
    expect(parse('acme/undeclared', {})).toEqual({});
  });

  it('still refuses an order that is neither direction', () => {
    expect(() => parse('acme/newest', { order: 'sideways' })).toThrow();
  });
});
