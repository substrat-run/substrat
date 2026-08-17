---
"@substrat-run/contracts": minor
"@substrat-run/engine-workorder": minor
---

**BREAKING:** `EntityDef.parent` becomes `parents`, and takes an array.

`entityRelations` is an **allowlist, not an assertion**. The kernel accumulates
permitted parents into a *set* per entity type
(`adapter-sqlite/src/index.ts:1348-1352`) and `ctx.link` checks membership — so an
entity legitimately has more than one, and two already do:

| entity | parents | declared by |
|---|---|---|
| `reservation` | `resource`, `member` | engine-booking, rally |
| `protocol` | `workorder`, `employee` | callout/handlebar, meridian |

Singular `parent` said *"the parent"*, which is not what the kernel means and
cannot express those. It had not bitten only because each parent is declared by a
different module, so no single registry needed both.

Renamed rather than widened to `Names | readonly Names[]`: a union leaves
consumers handling two shapes forever, and the plural name is the one that is
true. Migration is mechanical — `parent: 'customer'` → `parents: ['customer']` —
and the emitted `model.json` carries an array now, so the artifact of record has
one shape for anything reading it.

---

**engine-workorder declares its entity and exports its row schema.**

A composing vertical could not get the entity-type constant its permission-walk
edges name, nor a Zod schema for the row a declared operation returns — the same
two gaps engine-protocol just closed. `OrderRow` is now derived from the registry
rather than written beside it.

One entity, three tables: `workorder` is what the platform points at; time
entries and material lines are rows this engine owns and totals.

It declares **no `parents`**, deliberately. The parent is the vertical's noun —
Callout takes the manifest's `facility`, Handlebar hangs work orders off a bike —
and the manifest's hand-written `facility` edge stays until foreign entity names
become checkable.
