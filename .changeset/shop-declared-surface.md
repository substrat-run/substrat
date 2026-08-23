---
'@substrat-run/demo-shop': minor
---

Shop declares its operation surface, and its four list reads page

Twenty-one handlers registered as `'shop/checkout': checkoutOp as never`, and four of shop's
checks narrow to an entity. Undeclared they were undeclarable, since
`entityCheckConformanceSuite` derives its behavioural pair from an operation's `permission`
(#865/#891). `src/operations.ts` declares all twenty-one, `src/inputs.ts` and `src/schemas.ts`
carry the shapes, and `test/entity-checks.test.ts` drives the kit.

**One check is driven, and the reasons the other three are not are the finding here.**

- `shop/order` is driven, and it is not a small thing: an order carries a customer's name and
  prices, and a portal customer's whole access to it is one narrowed grant. It was already
  honoured.
- **`shop/checkout` is outside the kit's reach, and that is a limit of the kit rather than a
  gap in the vertical.** It narrows `order:read` to the customer being billed — the check its
  own comment explains ("*without this a shopper could place an invoice order billed to
  someone else's customer*") — but that check sits BEHIND the node gate `cart:checkout`. The
  kit's probe holds nothing scope-wide, which is exactly what makes its case 1 able to tell an
  entity check from a node check; so the probe fails the first line and never arrives.
  `alsoGrant` cannot bridge it either: it grants narrowed to the target entity, and a narrowed
  grant deliberately does not widen to satisfy a node check. The operation declares its opening
  gate, as Meridian's `hr/issue-employment-contract` does, and the second check is stated in
  prose. **A narrowed check behind a node gate is unreachable by this kit** — worth knowing
  before the pattern spreads.
- `shop/portal-orders` and `shop/my-customer` declare `narrows`: they ask per row.

`shop/catalog` is a third shape again — it opens with `shop:browse` and checks `catalog:manage`
only when the caller asks for drafts, so declaring that conditional gate would claim something a
caller omitting the flag does not pass.

**Breaking at the operation seam:** four reads now return `Page<T>` (#811). `shop/catalog` and
`shop/orders` are kernel-composed — the published filter now rides in the declared `filterable`
vocabulary instead of two hand-written queries, and orders keep `number DESC`. `shop/stock-overview`
joins products, variants and live reservations, and `shop/portal-orders` filters per ROW, so both
own their walk and page after it.

Over HTTP nothing renames: a page's body is still the entries and the walk rides in a `Link`
header (#829), so the storefront and the back office both still receive arrays.

**Migration checkpoint:** declaring `paged.over` makes the kernel provision list indexes, and
their version IS the declaration (`list/order:number+placed_at:customer_id+status`), so a widened
walk re-runs as a new migration. Shop provisions two; the scenario asserts them by name rather
than letting them appear silently. Across this series: booking 1, meridian 1, rally 1, shop 2.

Same gap as rally, flagged not fixed: most handlers still do not parse their declared input.
Shop already parses where it matters most — `paymentMethod` goes through `z.enum` at checkout,
because an unknown method would place an order that neither invoices nor charges.
