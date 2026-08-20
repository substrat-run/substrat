---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

Search: `searchables` becomes an index the kernel builds, and `ctx.search` reads (#827).

`manifest.searchables` has been in the contract since the beginning and nothing read it —
`kernel-design.md` deferred the backend decision "to first search consumer", so the
declaration was checked, linted and inert. Every search in the repo was a client-side
`includes` over a whole list, which is correct at forty rows and wrong at forty thousand —
and paged reads (#811) take that fallback away, because filtering a page in the browser
searches the first page only.

A vertical declares what is searchable, through the same helper that already checks the
fields against its entity registry:

```ts
...manifestEntities(calloutEntities, {
  searchables: [
    { entityType: 'customer', fields: ['name', 'number'] },
    { entityType: 'note', fields: ['body'], tokenizer: 'substring' },
  ],
}),
```

From that, the kernel derives a per-scope FTS5 index and the triggers that maintain it,
journaled like any other migration — the version *is* the declaration
(`search/customer:prefix:name+number`), so a changed declaration re-runs and shows up in the
migration diff a human reads. `ctx.search(entityType, term, { limit })` returns ids and
ranks; the caller hydrates them through the read path it already has.

Four decisions worth knowing:

- **Triggers, not the event spine.** The index is correct no matter who writes the row, no
  module gains a write path, and the read is read-after-write correct — a customer created
  in one breath is findable in the next. Indexing off events would have inherited the
  "don't use search for read-after-write flows" caveat for nothing.
- **Capped, not paged.** A relevance order has no stable sort key and therefore no honest
  cursor; the result set is capped and the caller narrows the term. Ordered paging stays
  what a declared sort on a list read is for.
- **Two tokenizers, declared per entity.** `prefix` (unicode61 + prefix index) by default;
  `substring` (trigram) opt-in, matching inside a word for a larger index. Terms below the
  index's floor are refused rather than answered by a scan.
- **The index never enters a dump.** Export skips it and its shadow tables — they cannot be
  replayed, and D1's own exporter refuses a database that merely contains an fts5 table —
  and import rebuilds it from the content tables it loaded. A fork searches immediately,
  with its triggers intact.

`OperationContext` gains `search`, and both hosts implement it against the shared contract
suite. `splitSqlStatements` learned that a trigger body's semicolons are not top level — the
derived DDL is the first thing in the repo to emit a trigger, and it passed on better-sqlite3
(one `exec`, whole blob) while failing every scope on the Durable Object host.
