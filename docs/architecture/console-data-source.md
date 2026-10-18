---
status: building
layer: plan
description: One query-first contract the console's views read; each source declares what it can answer.
---

# Console data sources

The sidekick that `substrat dev` serves (#2361) and the observability console (#1752) want the
same views: the request list with its facets, one request's waterfall, the process map, the
permission surface. The data behind them lives in three places. Locally it is the working tree
and the local trace buffer (#2358). In production it is the request record (#1746), Analytics
Engine and the lake. For a brownfield app it is an external tool. Writing the views once per
place means writing everything three times. So the views read one contract,
`ConsoleDataSource` in `packages/console-data`, and each place is a source behind it (#2360).

## Query-first

Every read is a bounded question: the requests in a window, their facet counts, one request's
trace, the vertical's artifacts. Local can also tail and production cannot. A contract that
promised tailing would build views that work under `substrat dev` and show nothing in
production. Tailing is therefore an optional method a source declares (`capabilities.tail`).
A view that uses it must still draw from a query alone.

## One shape

A request is the contracts' `TraceHead`, the head of the hosted invocation line under the
line's own field names. A trace is the contracts' `RequestTrace`. The package imports both and
redefines neither. This is what makes the hosted source "a different source, not a different
product" (#2357): a view cannot tell which source it reads except through the declared
capabilities. Facet keys and their reading (OR within a key, AND across keys, each key counted
with its own filter left out) copy the hosted reader's.

## Capabilities

A source declares `tail`, `rawPayloads`, `exactFacetCounts`, `traceSteps`, `model` and
`permissions`, plus the head fields it fills (`requestFields`). A view declares what it
requires and what it prefers (`VIEW_NEEDS`). `negotiate` settles them into one of three
outcomes: draw in full, draw and mark what was lost, or say why the view cannot be drawn. An
empty panel that reads as "nothing happened" is the failure this exists to prevent. For the
hosted source a missing step list is the normal case, not an error.

The expected profiles:

| | local | hosted | external |
| --- | --- | --- | --- |
| `tail` | yes | no | no |
| `rawPayloads` | opt-in, off by default | only under an explicit, audited, time-limited grant | no |
| `exactFacetCounts` | yes | no (estimates at volume, flagged per answer) | depends on the tool |
| `traceSteps` | yes | no (the head of each request) | no |
| `model`, `permissions` | the working tree | the running version | usually no |
| `requestFields` | all | all but `principal` and `specVersion` | whatever maps |

## The contract suite holds the declarations

A declaration nothing checks is a comment. `CONTRACT_CHECKS` is a suite of named checks that
every source runs against one fixed world. Each declared capability is a promise one check
holds the source to. A source that declares less passes with less. The package's own tests
show the suite bites: an honest head-only source in the hosted shape passes, and each liar
(exact counts that are estimates, bound values handed out without `rawPayloads`, a declared
tail that never delivers or hands out the whole trace, facets out of order or past the cap, steps from a source that declares none, a window ignored, a field
filled that was not declared, a model from a source that declares none) fails exactly the one
check named for its lie.

## Where it lives, and what is not here yet

`packages/console-data` holds the contract and the local source. It has no React, no Cloudflare
and no `node:*`, so the console, the dashboard and the dev server can all depend on it. It is
Apache-2.0 so the CLI can import it once it serves the sidekick, and private until then.

The local source reads nothing itself. Its caller passes the artifacts and a `TraceReader`, the
interface #2358's buffer will implement, so the package does not depend on the buffer.

The hosted source will run **behind the local dev server as a proxy**, so a token never reaches
the page. It is out of scope here, as is the external source. Both arrive as implementations
that pass the same suite.
