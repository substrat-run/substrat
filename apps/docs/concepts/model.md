# The model

A vertical's **model** is one TypeScript module — `spec/model.ts` — declaring what exists:
its entities, the operations over them, and the permissions those operations check.

It is not a schema language. It is TypeScript, because the compiler is what checks the joins
between those three things — and those joins are where the defects live.

## What it declares, and what it must not

| tier | contents | written by |
|---|---|---|
| **Declared** | entities, fields, relations, operations, permissions, events, returns | the model, human-approved |
| **Prose** | state machines, pricing, denial reasons, the seed cast | `spec/concept.md` |
| **Emitted** | `model.json`, the manifest's entity fragments, derived permission and event lists | code |
| **Authored** | handler bodies — the business logic | you |

The line: **the model says what exists and what shape it has; prose says how it behaves.**
If you find yourself inventing a way to declare a state *transition*, the boundary has
slipped.

There is deliberately **no tenancy annotation**, and there never will be. An operation runs
inside a scope that already *is* a tenant, and `ctx.sql` cannot reach another — so there is
nothing to forget. The best thing a modelling vocabulary can do with a rule is not need to
express it.

## Entities

```ts
import { defineEntities, emitModel } from '@substrat-run/contracts';
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
  },
});
```

Field names mirror the SQL columns exactly, snake_case included. A prettier domain naming
here would be a second description of the same rows, and two descriptions are how they come
to disagree.

**Not every table is an entity.** An entity is something the platform can *point at*:
attachments hang off one, [grants](/concepts/permissions) narrow to one, events are about
one. A price list keyed by article — no id, never an `EntityRef` — is a table your vertical
owns, not an entity.

`parents` is plural and takes an array because `entityRelations` is an **allowlist**: the
kernel accumulates permitted parent types into a set, so an entity legitimately has more
than one.

## Operations

```ts
export const PERMISSIONS = ['customer:manage', 'customer:read'] as const;

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
```

`input` is the **same Zod object your handler parses** — not a description of it. That is the
whole reason the model is TypeScript: a schema language would need the shape written twice,
and transcription is where argument names go wrong.

Omit `input` entirely for an operation that takes no body.

## What the compiler checks

Every one of these is a compile error, not a lint:

- `parents`, `key` and `erasable` name fields and entities that exist
- `permission` names a **declared** key — a typo becomes a *"Did you mean"* suggestion
- an operation carries `permission` **or** `narrows: { reason }` — never both, never neither
- every `{var}` in an `http` path names a real input field
- **`entityIdFrom` names a field of that operation's `output`** — for a mutation writing a
  *child*, the event is usually about the *parent*, so the id field and the entity differ
- `piiClass` is required, and anything other than `'none'` requires a `subjectId`, because an
  erasure has to be keyable
- a `payload` cannot carry a field the entity marks `erasable` — immutable events are the one
  place in a scope an erasure cannot reach

That last check resolves through `emits.entity`, so it is exact: a `name` marked erasable on
`customer` does not wrongly refuse an event about an `office` carrying its own `name`.

## Composing engines

An engine exports its entity registry and its published row schemas. Import them; never
retype an engine's shape.

```ts
import { protocolEntities, protocolInstanceRow } from '@substrat-run/engine-protocol';
import { workOrder, workorderEntities } from '@substrat-run/engine-workorder';

export const operations = defineOperations(entities, PERMISSIONS, [
  protocolEntities,
  workorderEntities,
])({
  'acme/open-job': {
    summary: 'Open a job and the work order it wraps',
    permission: 'customer:manage',
    input: z.object({ siteId: z.string() }),
    output: workOrder,                       // the engine's PUBLISHED type
    emits: { entity: 'workorder', /* the engine's entity */ … },
  },
});
```

Two things to know:

**A row is not a return.** `workOrder` is what an operation returns; `workorderRow` is what
the engine stores, and they differ — the row carries `facility_type`/`facility_id` as two
snake_case columns where the published type carries one `EntityRef` in camelCase. Return the
published one.

**Some engines are composed by event, not by call.** Check whether the engine exports
in-scope functions. `engine-invoicing` exports none — you *emit*, its consumers build the
invoice basis, and you read it back through its operations or by consuming its events. See
[Modules & the manifest](/concepts/modules).

## Binding the handlers

`OperationImpl` derives the handler map your operations require, and `satisfies` is the drift
detector:

```ts
export const operations = { … } satisfies OperationImpl<typeof model.operations, OperationContext>;
```

Change a declared return and `tsc` names the exact method whose handler no longer agrees. An
operation declared and not implemented — or implemented and not declared — is an error too.

## The manifest, derived

```ts
export const manifest = moduleManifest.parse({
  …,
  permissions: permissionsUsedBy(operations).map(/* … */),
  events: { emits: eventsEmittedBy(operations), consumes: [] },
  ...manifestEntities(entities, {
    engines: [protocolEntities],
    attachmentTargets: [{ entityType: 'customer', readPermission: 'customer:read' }],
    relations: [{ entityType: 'protocol', parentType: 'customer' }],
  }),
});
```

`entityRelations` is **derived** from each entity's `parents` — local edges are never written
twice. `relations` is only for edges involving a composed engine's entity, and both sides are
checked against local ∪ engine names.

## `model.json`

`emitModel(entities)` renders the registry to deterministic JSON, checked in and re-emitted
by `pnpm lint:model --check` — the same shape as the permission and API checkpoints, so a
changed table or a moved parent edge appears in the pull-request diff.

It is the artifact for consumers that **must not execute your code** (a hosted console
drawing your model) or that want diffability rather than validators (a breaking-change
classifier).

It is **not** the input for a code generator. `z.toJSONSchema` keeps declarative constraints
and drops programmatic ones — a `.refine()` and a `.brand()` vanish without trace — so a
generator reading the JSON would emit validators weaker than you declared. A generator reads
the TypeScript, where the Zod objects are live.

## See also

- [Modules & the manifest](/concepts/modules) — what a module registers
- [Permissions](/concepts/permissions) — keys, roles and the proof walk
- [Events & audit](/concepts/events) — fat payloads, `piiClass`, and the spine
