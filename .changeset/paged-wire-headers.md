---
'@substrat-run/contracts': minor
'@substrat-run/vertical-host': minor
---

A page's walk moves to response headers, so adopting paging breaks no client (#829).

`paged` (#811 / #823) wrapped a list read's response body: `[…]` — or a vertical's own
`{ customers: […] }` — became `{ entries: […], nextCursor }`. That renames a live
endpoint's contract, and a vertical publishing a REST API has no way to soften it: no
"serve both for one release", no version to hang a transition on, nothing in the emitted
document marking the change as breaking. So the rational move for anyone with API
consumers was **not to adopt**, which is the opposite of what an unbounded list read
deserves — and for the list reads whose published shape was a bare array it could not be
softened at all, because a body cannot be an array and an object at once.

The body is now the entries, and the walk rides in headers:

```http
GET /api/customers?limit=20&status=active

200 OK
Link: <https://api…/customers?limit=20&status=active&cursor=01J9A…>; rel="next"
X-Total-Count: 340

[ … ]
```

`Link` is RFC 8288 — the header GitHub serves — and it hands the client a URL to **follow**
rather than one to assemble, so the filters and page size travel with it. Its absence is
how a walk ends. Deliberately not `Content-Range: items 0-19/340`: that describes an offset
window, and keyset paging does not know its offset — that ignorance is what keeps it
correct while rows are being written, so a start index would be a number we invented.

**Inside the platform a page is still a value.** `stub.invoke` returns `Page<T>` exactly as
before — an operation is transport-agnostic, and a test, a seed or another operation has no
HTTP response to read a header off. This is a projection at the wire, applied by
`mountOperations`; handlers, `pageOf`/`countedPageOf` and the `paged` declaration are all
unchanged. A vertical supplying its own `respond` receives the whole `Page` and keeps
deciding its own body.

New in `@substrat-run/contracts`: `nextPageLink`, `isPage`, `PAGE_LINK_HEADER`,
`PAGE_TOTAL_HEADER`, `PAGE_EXPOSED_HEADERS`. The emitted OpenAPI documents the response as
an array of the declared entry plus both headers, so the walk is discoverable where a
client generator looks.

**One caveat this choice creates:** a browser client on a different origin cannot read
`Link` or `X-Total-Count` unless the server lists them in `Access-Control-Expose-Headers` —
and the symptom is not an error, it is a list that appears to have one page.
`PAGE_EXPOSED_HEADERS` is the list to expose. Nothing in the platform sets CORS today.

This changes a wire format shipped days ago in #823, whose adopters are `demos/todo` and
one production vertical. The platform's own control-plane API keeps the body envelope: its
consumers are the console and dashboard, versioned and deployed with it, so it has no
unknown client to protect.
