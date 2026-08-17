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

- **`parents`, `key`, `erasable`** name fields/entities that exist.
- **`permission`** names a key in `PERMISSIONS`. An operation carries
  `permission` **or** `narrows: { reason }` — never both, never neither.
- **`entityIdFrom`** names a field of that operation's **`output`**. For a
  mutation writing a *child*, the event is usually about the *parent*, so the id
  field and the entity differ — say which field carries it.
- **`piiClass`** is required. Anything other than `'none'` requires a
  `subjectId` naming an output field, because an erasure has to be keyable.
- **`payload`** cannot carry a field the entity marks `erasable`. Immutable
  events are the one place in a scope an erasure cannot reach.
- **`{var}`** in an `http` path names an input field.

If one of these fails, the model is wrong — fix the model. Do not reshape it to
silence the compiler.

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

## When you are done

Write `spec/model.ts` and stop. Say briefly what you declared and what you
deliberately left as prose, so the builder can approve or correct it.
