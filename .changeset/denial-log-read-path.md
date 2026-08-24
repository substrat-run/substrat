---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/contract-tests': minor
---

kernel: the denial log gets a reader (`listDenials`, `summarizeDenials`)

K-35 shipped the write side in both adapters four weeks ago. Every enforced `assertAllowed`
denial in production has been recorded since — actor, permission, node, operation, `at` —
written as a fresh autocommit *after* the rollback that would otherwise erase the evidence
of itself. **Nothing read it.** K-35 said so in its own last clause: the directory-side
surfacing "rides §5.4's admin-query RPC, unbuilt". The only consumer in the repo was a
contract test (#867).

That left the platform's three logs two-thirds built and asymmetric: `_substrat_admin_log`
holds staff mutations and is readable in the console, `_substrat_access_log` (K-24) holds
staff reads, and `_substrat_denials` (K-35) held refusals for nobody. It is the log that
matters most of the three, because it is the stronger kind of evidence. A generated
conformance report says *"we attempted the attack in CI at commit X"*; these rows say *"on
your data, in production, here is every refusal, by whom, against which key"*.

**The §5.4 RPC turned out to be built.** This is its first caller in the sense the decision
meant — two `HostAdmin` reads (`listDenials`, `summarizeDenials`), served as
`GET /tenants/:t/scopes/:s/denials[/summary]`, reached through the same delegation ladder as
the table reads: a hosted scope through its vertical's platform-gated `/internal/denials`,
a co-located one locally. Same `PlatformActorId`, same K-24 access-log entry, same K-3
`(tenantId, scopeId)` cross-check failing closed on a mismatch. Reading the denial log is
itself logged. The §7 bound holds unchanged: directory metadata and denial rows, never
tenant business data.

**Both of K-35's hedges were built rather than deferred, because both are load-bearing.**

*Rate-bucketing.* K-35 called it sanctionable up front, and the reason is not tidiness: a
probing client mints unlimited rows, so a newest-first page of 200 shows 200 rows from one
prober and hides everyone else — the read fails exactly when it matters. So the bucketed
view is the default surface, not a refinement, and it is ordered **by count**, which is what
keeps the quiet actor on the page beside the loud one. Buckets are (actor, permission) —
K-35's own "first occurrence + count per actor/key/window" — and carry `COUNT(DISTINCT
operation)` beside the count, because one operation refused four hundred times is a broken
screen or a misconfigured role while the same count across a dozen is someone walking the
surface.

*The window is not a retention policy.* Rows drain rather than expire (K-24's split), and
until a Tier 2 sink exists the window simply **is** the retention. So the summary reports
the log's oldest and newest held rows computed **ignoring the filter** — a fact about the
log, not about the query. That is what stops an empty result being read as "this never
happened" when the truth is "we no longer hold that far back", and an empty log reports a
null window rather than a fabricated instant.

Both adapters answer from one shared SQL builder (`kernel/denial-query.ts`), the same shape
`platform-request-query.ts` uses, so the pure-SQLite host and the Durable Object cannot
drift on what "newest" means or what a bucket groups by. The filter takes the **logical**
actor — a bare principal ULID — and normalizes to the stored `JSON.stringify` encoding, so
no call site has to know how the writer spells it.

Ten contract-suite tests run against both hosts, including the DO path. Three of them pin
properties rather than plumbing: that buckets are count-ordered so a flood cannot hide a
quiet actor, that a window bound narrows `total` and never the window, and that a bare
`ctx.check` a module branches on writes no denial — K-35's deliberate silence, asserted
through the read surface an operator actually sees.

The console renders it per scope, bucketed, with the window stated in the card's own caption.
