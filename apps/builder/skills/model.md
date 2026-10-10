# The model phase

The concept is approved. Before any code, declare **what exists** in
`spec/model.ts`. Write that file, then end the turn.

You write **only `spec/**`** this turn. The build begins next turn and
*transcribes* this model — it does not re-decide it.

## Why this phase exists

The build used to make design decisions and stabilise them through the gates at
the same time. That is what makes it thrash. Entities, operations, permissions
and returns get decided once, here, in an artifact a human reads and approves.

Everything downstream is derived from it: migrations, the manifest, the route
table, the permission registry, the API document.

## The file

```ts
import { defineEntities, defineOperations, emitModel, manifestEntities, money } from '@substrat-run/contracts';
import { z } from 'zod';

export const entities = defineEntities({
  customer: {
    table: 'acme_customers',
    fields: z.object({
      id: z.string(),
      number: z.string(),
      name: z.string(),
      created_at: z.string(),
    }),
    key: ['number'],
    erasable: ['name'],
  },
  site: {
    table: 'acme_sites',
    fields: z.object({ id: z.string(), customer_id: z.string(), address: z.string() }),
    parents: ['customer'],
    erasable: ['address'],
  },
  inquiry: {
    table: 'acme_inquiries',
    fields: z.object({ id: z.string(), customer_id: z.string(), subject: z.string(), created_at: z.string() }),
    parents: ['customer'],
    // The sender typed it: kept on the row, never on an event.
    outsideText: ['subject'],
  },
});

export const PERMISSIONS = ['customer:manage', 'site:manage'] as const;

export const operations = defineOperations(entities, PERMISSIONS)({
  'acme/create-customer': {
    summary: 'Register a customer',
    permission: 'customer:manage',
    input: z.object({ number: z.string(), name: z.string() }),
    output: entities.customer.fields,
    http: { method: 'POST', path: '/customers' },
    emits: {
      entity: 'customer',
      entityIdFrom: 'id',
      type: 'acme.customer-created',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'number'],
    },
  },
});

export const model = emitModel(entities);
```

## Rules that are compile errors, so you cannot get them wrong quietly

- **`parents`, `key`, `erasable`, `outsideText`** name fields/entities that exist.
  `erasable` is the person's own data — what an erasure must reach. `outsideText` is
  text someone OUTSIDE the app wrote that is not personal data: a subject line a
  customer typed, an error a provider or a remote site returned, a fetched document, a
  raw header. Mark a column `outsideText` whenever its value comes from a customer, a
  remote system or an inbound header and it is not already `erasable`.
- **`permission`** names a key in `PERMISSIONS`. An operation carries
  `permission` **or** `narrows: { reason, checks }` — never both, never neither.
- **A `permission` says WHAT IT CHECKS AGAINST.** A bare key means the node —
  the whole scope. A check on one thing says so:

  ```ts
  permission: { key: 'list:manage', entity: 'list', idFrom: 'listId' }
  ```

  `idFrom` names the input field carrying that entity's id. When the id is not
  in the input — an operation taking an item but checking the list it sits on —
  use `resolved: '<the reason>'` instead: it still records that this is not a
  node check, while being honest that the handler has to find the entity.

  Get this wrong in the open direction and the operation passes for anyone
  holding the key anywhere in the scope, with every test still green. Ask of
  every operation: *does holding this key somewhere else in this workspace
  entitle you to do it HERE?* If not, it is narrowed.
  `checks` names THIS module's keys the per-entity walk evaluates (`[]` when it
  walks only on a composed engine's key, which the engine declares). It is
  required because a key reached only by a walk would otherwise vanish from the
  permission review.
- **`entityIdFrom`** names a field of that operation's **`output`**. For a
  mutation writing a *child*, the event is usually about the *parent*, so the id
  field and the entity differ — say which field carries it.
- **`piiClass`** is required. Anything other than `'none'` requires a
  `subjectId` naming an output field, because an erasure has to be keyable.
- **`payload`** cannot carry a field the entity marks `erasable` or `outsideText`.
  Immutable events are the one place in a scope an erasure cannot reach, and no
  cleanup of the row reaches them either. A consumer that needs the text reads the
  row by the id the event carries.
- **`{var}`** in an `http` path names an input field.

If one of these fails, the model is wrong — fix the model. Do not reshape it to
silence the compiler.

## Who writes the handler: `derive` or `authored`

Some operations are described completely by their declaration, and the platform
writes their handler. There are four such shapes: a `get` of one row by its id, a
`list` that is a `paged.over` page of the entity's own rows behind declared filters,
an `update` that is a `PATCH` field bag with `concurrency`, and a `delete` of a row
no entity declares as parent. Each of these operations must say who writes its handler:

```ts
'acme/get-customer': {
  summary: 'One customer',
  derive: 'get',
  permission: { key: 'customer:manage', entity: 'customer', idFrom: 'customerId' },
  input: z.object({ customerId: z.string() }),
  output: entities.customer.fields,
  http: { method: 'GET', path: '/customers/{customerId}' },
},
```

`derive: '<shape>'` means the build writes no handler for it. `authored: '<reason>'`
keeps the handler hand-written, and the reason says what the derived one would get
wrong here (a projection, a parent-existence check, a cascade). `defineOperations`
refuses, at load, an operation of one of these shapes that declares neither, and
names the shape. It also refuses a `derive` that does not match its shape, and an
`authored` on an operation nothing could derive. Prefer `derive`; write `authored`
only with a reason a reviewer could disagree with.

## What does NOT go here

**Behaviour.** State machines, pricing rules, who may do what and when, the seed
cast, denial reasons — those stay prose in `spec/concept.md`. If you find
yourself inventing a way to declare a *transition*, the boundary has slipped.

**Anything the platform already guarantees.** There is no tenancy annotation and
there must never be one: an operation runs inside a scope that already *is* a
tenant, and `ctx.sql` cannot reach another. There is nothing to forget, so there
is no way to forget it. The best thing this vocabulary can do with a rule is not
need to express it.

**A second naming.** Field names mirror the SQL columns exactly, snake_case
included. A prettier domain naming here would be a second description of the same
rows, and two descriptions are how they come to disagree.

## Not every table is an entity

An entity is something the platform can *point at*: attachments hang off one,
grants narrow to one, events are about one. A price list keyed by article — no
id, never an `EntityRef`, never a permission-walk node — is a table this vertical
owns, not an entity. Leave it out and declare its shape where it is used.

## Composing engines

An engine's entities and row schemas are importable. Use them; never retype an
engine's shape.

```ts
import { protocolEntities, protocolInstanceRow } from '@substrat-run/engine-protocol';
import { workOrder, workorderEntities } from '@substrat-run/engine-workorder';

...manifestEntities(entities, {
  engines: [protocolEntities, workorderEntities],
  // Edges involving an engine's entity. Local edges come from `parents` and do
  // not belong here.
  relations: [{ entityType: 'workorder', parentType: 'site' }],
})
```

`workOrder` is what an operation **returns**; `workorderRow` is what the engine
**stores**, and they are different shapes. Return the published one.

### Some engines are composed by EVENT, not by call

Check whether the engine exports in-scope functions. If it does not — `invoicing`
is the case — you **cannot call it**, and no amount of trying will work: its
tables are private (rule 4) and a vertical cannot invoke another module's
operation from inside its own.

Compose it by *emitting* instead. Completing a work order is what makes an
invoice basis appear; the vertical then reads it back through the engine's own
operations, or consumes the engine's event into its own side table keyed by the
engine's id.

So an operation like "issue the invoice" is the vertical's **sign-off on its own
row**, not a call into the engine. Declare its `output` as something this
vertical owns.

## When you are done

Write `spec/model.ts` and stop. Say briefly what you declared and what you
deliberately left as prose, so the builder can approve or correct it.

Next is the **scenario phase**, not the build: the concept's scenario becomes a
failing suite before any code exists, so that something in the project is still
capable of disagreeing with this model.
