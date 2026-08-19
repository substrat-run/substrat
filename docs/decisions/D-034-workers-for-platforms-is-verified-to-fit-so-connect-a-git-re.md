---
id: D-34
date: 2026-07-19
layer: plan
title: "Workers for Platforms is verified to fit, so \"connect a git repo\" is a COMMERCIAL gate, not…"
status: accepted
aliases: []
tracking: []
---
# D-34 — Workers for Platforms is verified to fit, so "connect a git repo" is a COMMERCIAL gate, not…

**Workers for Platforms is verified to fit, so "connect a git repo" is a COMMERCIAL gate, not a technical one** (K-28). D-33 called milestone one demo-instantiation rather than git-push because "arbitrary customer code needs Workers-for-Platforms" and that was an open technical risk. It is no longer open: a user worker in a dispatch namespace **may define its own SQLite Durable Object class**, tested end-to-end rather than inferred — which is the one property the whole architecture depended on, since `defineScopeDO(MODULES)` means a vertical *is* a Durable Object rather than something that talks to one. D-30 survives intact: separate scripts, separate DO classes, no lockstep engine upgrades. What actually gates git-push now is that **WfP is a paid add-on we have not bought** (`code: 10121` on both our accounts), so it joins Regional Services (K-26) as a plan dependency in D-32's cost model. **The sequencing consequence: build the orchestration layer against the ORDINARY Workers upload API first.** Platform-owned deploys need no WfP at all — we upload with our credentials and the customer never holds a Cloudflare token, which is the whole of "we host it" — and that path provably supports DO classes because it is what `wrangler deploy` already uses for our own verticals. Move to dispatch namespaces when script count or tenant isolation demands it; the router's `verticalFor` swaps a service binding for `env.DISPATCH.get(name)`, the same `Fetcher` type, one function

## Why

This narrows D-33 rather than overturning it: demo instantiation is still the right milestone one, but for a smaller and more honest reason — not "the platform cannot host customer code" but "we have not yet needed to pay for the version that scales". Worth the distinction, because a technical blocker invites redesign and a line item invites a purchase decision, and treating the second as the first would have bought a redesign nobody needed. The spike also surfaced something no document would have: a newly-uploaded user worker is not instantly dispatchable everywhere — one scope failed with `Worker not found.` for ~15s while siblings on the same script succeeded, because its DO landed in a colo the script had not reached. Upload-succeeded is therefore not ready-to-serve, and the orchestration layer must gate hostname binding and channel promotion on a readiness check rather than on the upload response. That would otherwise have been learned from a customer
