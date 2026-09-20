---
id: D-61
date: 2026-09-20
layer: plan
title: "DO-originated egress is observed and never refused: D-46's limit stands, and no platform-authored code enters a customer's bundle"
status: proposed
aliases: []
amends: []
tracking: ["#861", "#1579"]
---
# D-61 — DO-originated egress is observed and never refused: D-46's limit stands, and no platform-authored code enters a customer's bundle

> Proposed, not accepted. It closes the fork [#861](https://github.com/substrat-run/substrat/issues/861)
> states and [D-58](./D-058-d-46-s-durable-object-limit-is-enforcement-only-do-originat.md)
> deferred to it, and it should be argued before the observation it commits to is paid for on
> production.

**DO-originated egress is observed and never refused — [#861](https://github.com/substrat-run/substrat/issues/861)'s
Option A — so [D-46](./D-046-a-hosted-vertical-s-outbound-egress-is-a-declared-per-versio.md)'s
Durable-Object limit stays exactly as written and no platform-authored code is injected into a
customer's bundle.** The mechanism is the one already built, unchanged: `apps/vertical-egress/src/worker.ts`
is an out-of-process outbound worker on the dispatch namespace, deciding per subrequest and metering
all five verdicts (`:143`, `:158`–`:206`), and its own header already carries the limit and D-58's
correction to it (`:49`–`:61`). What is deliberately not built is Option B, a build-time preamble
wrapping `globalThis.fetch` inside the bundle. **Option B is refused on the line
[D-2](./D-002-runtime-enforcement-over-conventions-codegen.md) draws, not on taste**: a wrapper
looks like runtime enforcement and is not one, and what decides that is *who hands the capability
over*. [#954](https://github.com/substrat-run/substrat/issues/954)'s spine guard holds against an
uncooperative bundle because `ctx.sql` is constructed by the host and handed over already wrapped
(`packages/kernel/src/spine-guard.ts`; applied at `packages/adapter-cloudflare/src/sql.ts:23` and
`packages/adapter-sqlite/src/index.ts:8925`), so module code never holds the unwrapped connection.
`globalThis.fetch` is ambient — the bundle holds the real one from the first line of its first
module — so a preamble is something the platform lays *over* a capability the code already has,
which is a convention that happens to execute. The issue's own three costs stand beside that and
are not restated here except to note the decisive one: the mature answer to an untrusted caller is
out-of-process interception, and `apps/vertical-egress` already *is* that answer for the half it
can see. **And for an honest author the gap a wrapper would close is nearly empty by
construction.** Module code — everything reachable from a `ModuleRegistration`, which is exactly
what runs inside the scope DO (`packages/adapter-cloudflare/src/scope-do.ts:716`, the operation path
at `:1485`) — may not call `fetch` at all: that is boundary-lint R3,
`packages/boundary-lint/src/index.ts:919`–`:921`. So a DO-originated fetch is either code that has
already broken a rule — the hostile case, which a wrapper does not reach — or harness code inside a
vertical's own declared DO class, where a per-version host allowlist is sometimes not expressible at
all. **That clause is not hypothetical, and it is the concrete price of B.** `demos/auth-server`
reaches production through `substrat push` like any other vertical
(`.github/workflows/auth-server-deploy.yml:129`), and its whole Better Auth issuer runs inside a
Durable Object (`demos/auth-server/src/auth-do.ts:389`–`:422`) — including every federated token
round-trip and its Client ID Metadata Document read
(`demos/auth-server/src/cimd-fetch.ts:190`, wired in at `auth-do.ts:164`) — where the destination is
a caller-supplied `client_id` URL, so the admissible host set is unbounded by protocol design. It
declares no `substrat.outbound`, which the CLI sends as `[]` (`packages/cli/src/push.ts:1254`), so a
wrapper enforcing the declaration inside the DO would refuse every one of those calls on that
vertical's next push. What the file does instead is a *shape* check — https only, no credentials in
the URL, no special-use host (`cimd-fetch.ts:184`–`:188`) — written in-process by the author who
knows what the surface is, which is the right answer there and the wrong thing for a platform to
impose from outside. **What "observe" costs has to be stated, because on production there is
currently nothing to observe.** Verified rather than inferred from the issue: spans are turned on by
a `traces` block that rides an upload (`packages/control-plane-api/src/wfp.ts:66`–`:85`, emitted at
`:316`–`:318`), the control plane derives its rate from `VERTICAL_TRACE_SAMPLING`
(`apps/control-plane/src/worker.ts:363`–`:368`, passed at `:390`), and that var is set **only**
inside the `test` environment (`apps/control-plane/wrangler.jsonc:249`, in the `env.test` block
opened at `:224`–`:225`). None of which needs deriving, because the comment directly above that
variable says it outright — *"Prod sets nothing, so prod scripts keep emitting logs and no spans"*
(`:244`). So every prod-pushed script still ships `observability: { enabled: true }` and no `traces`
block, and `GET /verticals/:slug/egress` (`packages/control-plane-api/src/api.ts:4807`) reads an
empty set for every version the production control plane uploaded — rendering a clean bill of health
it has not earned, which is worse than an empty screen because it answers the question falsely.
Choosing A is choosing to buy the observation: a production rate has to be picked and paid for, one
real operation approaches twenty spans (D-58), and nothing is retroactive — the rate arrives
vertical by vertical as each re-pushes. **That is one decision with two settings rather than two
decisions**, because the same comment sets a review point that has now arrived: it reads *"Turn this
off, or down, once #858 reports; beta pricing ends 2026-10-01"* (`:246`–`:247`), and #858 closed
completed on 2026-09-19. TEST therefore samples at `1` — every span on every pushed script — while
production samples nothing, eleven days before the billing change, and whoever picks the production
rate is already in that file. **The residue is named rather than discovered later**, and
[#1579](https://github.com/substrat-run/substrat/issues/1579) now holds it: A leaves the hostile
bundle exactly where it found it. The follow-up #861 itself proposed — running the layer rules
platform-side at push/admit over the built bundle — is no longer available in that shape, because
[#955](https://github.com/substrat-run/substrat/issues/955) closed by establishing that the control
plane receives a wrangler-built bundle and never the source the rules are written against, while
`packages/cli/src/push.ts:805` still points back here for the platform-side half. Two smaller
drifts, recorded because they narrow the issue's own framing: *"`fetch` is the surface that
remains"* is too narrow, since [#1054](https://github.com/substrat-run/substrat/issues/1054) has the
platform inject an `ai` binding on every pushed script (`apps/control-plane/src/worker.ts:389`,
`wfp.ts:65`) — a type the sandbox contract refuses when a vertical *declares* it
(`packages/contracts/src/deploy.ts:301`–`:304`) — and a binding is not a subrequest, so neither the
egress worker nor any `fetch` wrapper would see it; its own docblock already prices that as
unattributed spend on the platform's account (`wfp.ts:60`–`:63`), a cost surface rather than an
exfiltration one. And D-58's prose says detection "splits origin on `cloudflare.entrypoint`", where
the shipped code keys on the span's `cloudflare.durable_object` block and says why one line above —
a worker-context fetch can carry an entrypoint too (`packages/control-plane-api/src/cf-observability.ts:954`–`:961`)

## Why

Worth a ledger entry rather than a comment on the issue because three places already defer to #861
for this answer and would be stranded by a close: `packages/cli/src/push.ts:805` sends the
platform-side-check question here, #862 shipped its R2 fix with the same question explicitly
deferred here, and #955's closing comment names *"#861's DO-egress question"* as the third of the
three runtime constraints that actually bound deployed code. Two of those three now say yes — the spine-write refusal and the D-46
allowlist — and this one says no, which is a fact a reader of `apps/vertical-egress/src/worker.ts`
or [self-serve-deploy.md](../architecture/self-serve-deploy.md) §4.2 should be able to land on
rather than reconstruct. **The fork is decidable now for a reason that is not the one the issue
expected.** #861 parked itself behind #858 and #859 on the theory that seeing the calls would settle
whether to refuse them; D-58 delivered that and the deciding evidence turned out to be somewhere
else — the gap has a live, honest occupant. In August the question read as *"do we tolerate a
hole"*. With an OIDC issuer sitting in it, whose protocol surface cannot be expressed as a host
list, it reads as *"do we break an issuer to close a hole against an attacker the same move does not
stop"*, and stated that way there is no fork. **Nor is "defense in depth, it costs little" available
as a tiebreak.** The issue prices a wrapper correctly as *"one more thing to choose not to defeat,
the same class as R2–R7, and worth about what a lint rule is worth"* — but a lint rule costs a regex
in our own repo, while this costs platform-authored code inside every customer's bundle, on the
serving path, in someone else's dependency tree, with a failure mode where our preamble breaks a
vertical that did nothing wrong. Defense in depth that ships *in the artifact it defends against* is
not cheap the way a lint rule is cheap, and the asymmetry is what makes the two incomparable.
**What this entry does not do**, said plainly because a decision that hides its own residue is worth
less than none. It does not narrow the D-46 gap by a single call. It does not answer
[#860](https://github.com/substrat-run/substrat/issues/860): a head-sampled span retained three to
seven days is a drift signal, and the compliance question still wants a durable record. It does not
make the drift report true on production until somebody sets a sampling rate and accepts the bill,
which is the one action this entry actually obliges. And it does not claim the honest-author threat
model is right forever — only that it is the model every other mechanism in this cluster was built
for, and that changing it is a funded programme (#1579) rather than a preamble. D-58 refused to let
a true limit acquire a false corollary; this refuses the mirror error, which is letting a true limit
acquire a false remedy
