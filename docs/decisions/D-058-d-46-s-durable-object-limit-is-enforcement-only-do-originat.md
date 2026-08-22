---
id: D-58
date: 2026-08-22
layer: plan
title: "D-46's Durable-Object limit is enforcement-only; DO-originated egress is observable"
status: accepted
aliases: []
tracking: ["#863", "#858"]
---
# D-58 — D-46's Durable-Object limit is enforcement-only; DO-originated egress is observable

**D-46's Durable-Object limit is enforcement-only: DO-originated egress is observable, and the
visibility corollary read into that limit is false** (corrects a reading of
[D-46](./D-046-a-hosted-vertical-s-outbound-egress-is-a-declared-per-versio.md), not its
enforcement half; [#863](https://github.com/substrat-run/substrat/issues/863),
[#858](https://github.com/substrat-run/substrat/issues/858)). D-46 shipped an honest limit —
Cloudflare outbound workers do not intercept Durable-Object-originated subrequests, and verticals
are DO-centric, so the mechanism is "defense-in-depth plus a reviewed contract, not an airtight
sandbox". **That half stands, unchanged and for the stated reason.** What has aged out is the
consequence readers take from it: that DO-originated egress is therefore also *invisible*. Workers
automatic tracing instruments workerd itself, and a `fetch` made inside a scope DO produces a
`fetch` span carrying `url.full`, `server.address`, `http.request.method` and
`http.response.status_code`, plus `cloudflare.entrypoint` and `durable_object.id` — which
distinguish DO-originated from worker-context egress without relying on span parentage. Verified on
TEST with a throwaway dispatch-namespace probe rather than inferred from a doc, because Cloudflare
documents neither half: **spans do reach dispatch-namespace user workers** (no account enrollment,
no compatibility flag), **they land in the platform's account** (the upload runs with the platform's
credentials, so they can land nowhere else), and `$metadata.service` is **the vertical's own script
name**, never the dispatcher's. [#859](https://github.com/substrat-run/substrat/issues/859) ships
the consequence: `GET /verticals/:slug/egress` aggregates those spans to `(service, host, origin)`
and joins each against the declared `outbound` of the version that deployment ref belongs to,
rendered beside the console's Admit button. Three traps recorded because each fails silently — spans
live in dataset **`otel`**, and a query naming `cloudflare-workers` returns an empty result with
`success: true` (0 traces after reading 41M rows over seven days, while 38 sat there);
**`durable_object_subrequest` is a decoy**, firing for the worker→DO hop and for DO→DO stub calls,
carrying no url or server and proving nothing about egress, so detection keys on `fetch` spans and
splits origin on `cloudflare.entrypoint`; and **the dispatcher and the vertical produce separate
`traceId`s**, because the 2026-05-07 worker→worker trace unification does not cross the dispatch
boundary. **Visibility is not a record**: tracing is head-sampled, retains 3–7 days, bills per span
after 2026-10-01, and emits one `durable_object_storage_exec` span *per SQL statement* — so a real
operation approaches 20 spans and 100% sampling is a TEST-only setting. The compliance question
therefore stays with [#860](https://github.com/substrat-run/substrat/issues/860) and the
enforcement fork with [#861](https://github.com/substrat-run/substrat/issues/861)

## Why

Worth a decision rather than an edit to D-46 because the ledger is append-only and D-46 stated one
fact whose corollary aged out — [K-36](./K-036-kv-s-disqualifier-is-missing-data-residency-not-a-regional-s.md)'s
shape exactly, and recorded the same way. K-30 recorded "Workers KV is incompatible with Regional
Services"; open question 5 inherited "the router's per-request directory read cannot be cached" and
carried it for months as a platform constraint we did not actually have. The risk here ran in the
same direction: read as written, D-46 says DO egress cannot be *policed*, and the reader concludes
it cannot be *audited* — which would have sent the disclosure register (#860) and the drift report
(#859) hunting for mechanisms the runtime already provides. That is not hypothetical; #859 was built
on this correction and is live. **The probe is the load-bearing part**, and it is K-36's own closing
discipline applied: re-verify at build time, do not trust a doc where a deployment is cheap. Two
findings only a deployment could produce. The fleet has always sent `observability: { enabled: true }`
on every pushed script, which reads like tracing was already on — it is not; during the beta that
flag enables **logs only**, so the fleet emitted zero spans for the entire period it appeared
instrumented. And nothing is retroactive: the setting rides an upload, so a vertical emits nothing
until its next push. What this entry does **not** do is narrow the gap it corrects — a fetch made
inside a scope DO is still not refused, only recorded afterwards, and only if sampling caught it
