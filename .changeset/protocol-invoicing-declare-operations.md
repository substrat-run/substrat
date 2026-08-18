---
'@substrat-run/engine-protocol': minor
'@substrat-run/engine-invoicing': minor
---

The protocol and invoicing engines declare their operation surfaces, completing
the set — every engine a vertical composes now publishes what can be done to it,
so a route binding is a name and a path.

Callout goes from 12 of its 27 routes derived to 21.

**engine-protocol** declares all fourteen. Its input schemas move to `inputs.ts`
and four composite returns become schemas (`signResult`,
`requestSignaturesResult`, `protocolDetail`, `protocolSummary`), each asserted
exact against the interface the handler returns in both directions, like the row
shapes before them. The package's export surface is unchanged: everything moved
is re-exported from the root, so an import that worked yesterday still resolves.
One addition, `contentUnion` — the content VALUE a caller receives, as distinct
from `protocolTemplateContent`, the preprocessing parser that normalises
discriminant-less legacy rows into it.

**engine-invoicing** declares its three. The engine is composed by *event*, so
those three are the whole callable surface and none of them creates anything — a
basis is built by a consumer, and a test asserts that absence, because a creating
operation appearing there would mean a second way in past the invariants
immutable-after-export depends on. Its two read projections are published as
`underlagListRow` and `underlagDetail`.

**One finding worth carrying forward.** Typing a handler *from* its declared
schema (`z.infer`) looks like a drift check and is not one: a schema that DROPS a
field the handler still returns goes on compiling, because an object with extra
properties is assignable to a narrower type. It catches a retyped field and
misses a missing one — and a schema narrower than the projection publishes a
contract that omits real data, which is what a UI lane would fork on. Two
independent descriptions held together by an exactness assertion catch both
directions; that is the pattern used throughout, and every assertion here is
mutation-tested.

**`protocol/list-for-entity` declares `narrows` rather than a leading
permission.** It checks `protocol:read` against the entity the protocols hang on,
so the entity's TYPE arrives as data — and a declared entity check must name a
type known up front. Extending the vocabulary was considered and rejected: a
declaration that cannot express something is not an argument for a richer
declaration. `narrows` records the fact that protects anything — this is not a
node check — and names the walked key, so `protocol:read` still reaches the
permission review.

Closes #738 and #739.
