---
'create-substrat': patch
---

The scaffold template now declares its model. `src/entities.ts` declares the bike
shop's entities with `defineEntities`, `src/operations.ts` declares its ten
operations with `defineOperations`, and `src/module.ts` binds its handlers to that
declaration with `satisfies OperationImpl<…>` instead of a string-keyed `as never`
table — so a handler that disagrees with its declaration is a compile error at the
exact method. The three list reads (`shop/list-customers`, `shop/price-list`,
`shop/timeline`) now answer with a page rather than the whole table, which is what
declaring the surface forces. `src/routes.ts` forwards the page trio and projects the
walk into a `Link` header, so every paged read the scaffold serves — the engines' list
reads included — can be walked past its first page over HTTP.
