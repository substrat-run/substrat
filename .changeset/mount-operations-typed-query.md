---
'@substrat-run/vertical-host': minor
---

`mountOperations` types the values a URL carries, and refuses a route that can
never be reached.

Two things a hand-written route table did for free, found by a vertical with 195
declared routes that could not switch to the derived mount without them (#785).

**A query string carries no types.** `?limit=100` arrived as the string `'100'`,
so an operation declaring `limit: z.number().int().optional()` rejected its own
endpoint with "expected number, received string". That is the most common read
shape there is — 29 of that vertical's 81 reads carry a paging `limit` — and the
mount, not the model, is where the fix belongs. Declaring `z.coerce.number()`
instead would make the transport's problem true everywhere else too: for the
JSON body, for a direct `stub.invoke`, and for every test. `input` is the same
Zod object the handler parses, and it has to stay transport-agnostic to be worth
anything.

So the mount reads the declared shape and coerces the fields whose declared type
cannot be a string — `number`, `boolean`, `bigint`, looked through `optional`,
`nullable`, `default`, `catch` and a pipe's input side. Path parameters get the
same treatment, since `/pages/{page}` had the identical problem. Chosen over
coercing by JSON grammar, which cannot tell `?q=123` the search term from
`?q=123` the number without an encoding convention every caller has to honour.
A value the declared type cannot accept passes through unchanged, so the error
still names what the caller actually sent rather than "received nan".

**Registration order decided routing by operation name.** Hono dispatches in
registration order, and this registered in alphabetical order of the operation
name — a name with no relationship to routing precedence. `support/get` sorts
before `support/list-mine`, so a live `GET /support/issues/mine` disappeared
behind `GET /support/issues/{id}`: no error, no warning, just an endpoint that
silently belonged to its neighbour.

Routes are now ordered by path specificity, segment by segment, static before
parameter. That is not a house rule — it is the precedence OpenAPI already
writes down for exactly this case, and it keeps a reserved word in an id slot
working without renaming a live URL.

What ordering cannot resolve now fails loudly: two operations that dispatch
identically (same method, same path shape, different parameter names) throw at
mount naming both, because there is no reading under which both are live.
