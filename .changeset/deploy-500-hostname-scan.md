---
"@substrat-run/control-plane-api": minor
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/adapter-sqlite": minor
"@substrat-run/contract-tests": minor
"@substrat-run/kernel": minor
---

fix(control-plane): a push stops reading the whole fleet to warn about its own surfaces

A `substrat push` answered `500: internal error` **after** its version had already been
published — the bundle uploaded, the version landed admitted, and only then did the
request die. Each CI retry burned another version label and left another admitted version
behind for a deploy that reported failure, so a PR's three attempts produced `…-pr-30.1`,
`.2` and `.3` and no working preview.

The throw was in the advisory surface-drift check, which is the last thing a deploy does.
It asked for **every hostname binding on the platform** and filtered to the pushed slug in
JS. Two things were wrong with that, and only together do they make an outage:

`mapHostname` read the stored cert-validation records with a bare `JSON.parse`. That column
is the one part of a hostname row this platform does not write — it is whatever the
Cloudflare custom-hostname API returned, stored verbatim — so an unreadable blob there is a
`SyntaxError`, which is not a `ZodError`, which `mapError` does not recognise, which is a
blank 500. Because the read was fleet-wide, a cert detail belonging to one tenant's custom
domain could stop an unrelated vertical from shipping, with nothing in the response saying
so.

So: **narrow the query, and never throw on that column.** `listHostnames` takes a
`verticalSlug` filter, implemented in SQL by both adapters, and the deploy path asks for the
bindings it actually wants — the rows that answer the question are now the only rows that
can break it. `parseValidationRecords` (kernel, shared by both adapters so neither can be
the lenient one) degrades a malformed or wrong-shaped blob to "no records". Nothing routes
on those records; they are a copy-this-CNAME hint, and `substrat hostnames verify` re-polls
issuance and rewrites them.

**And the read that was never the right shape.** "The version with this id" was spelled as
an unpaginated `listVersions(slug)` followed by `.find()` — every version a vertical ever
published, each carrying its stored manifest, pulled across the adapter boundary to keep
one. That cost grows once per push and lands hardest on the paths least able to afford it:
the deploy handler's own read-back, and the router's per-request resolution of which script
serves a scope. New `HostAdmin.getVersion(actor, versionId, verticalSlug?)`, implemented by
both adapters, replaces nine such call sites. The optional slug preserves what
`.find()`-inside-one-slug's-list gave for free — a version of another vertical reads as
absent rather than being handed back across the lineage boundary.

The retries remain non-idempotent: a push that fails after `publishVersion` still consumes
its version label. Left alone here because making a push resumable is a design change, not
a fix, and it is no longer reachable by this route.
