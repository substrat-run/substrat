---
id: D-40
date: 2026-07-28
layer: plan
title: "The hosted-vertical sandbox is a positive binding allowlist, not a denylist"
status: accepted
aliases: []
tracking: ["#302", "#301"]
---
# D-40 — The hosted-vertical sandbox is a positive binding allowlist, not a denylist

**The hosted-vertical sandbox is a positive binding allowlist, not a denylist** ([#302](https://github.com/substrat-run/substrat/issues/302); self-serve-deploy.md §4.1). `assertSandboxContract` refused a known-bad shortlist (`CONTROL_PLANE`, `service`, cross-script DO) and *allowed everything else by omission* — KV/Queues/R2/analytics were neither named nor validated, and an unrecognized type sailed through. Inverted: a vertical may declare only its OWN resources, from one written set (`ADMISSIBLE_BINDING_TYPES` in contracts) — its DO classes (own class only) plus own data stores (`d1`, `kv_namespace`, `queue`, `r2_bucket`, `analytics_engine`) and inert `secret_text`/`plain_text`; anything else is refused *by omission*, with a message that names the binding and its type and points at the doc. Two posture calls settled: own→own **service bindings stay rejected** (a hosted vertical is one serving script — no own sibling to bind, and platform reach is the router, K-27); own **`d1` stays admitted** but its `database_id` ownership is still unproven — trusted under model-B human admission until platform provisioning injects the id (#301). `CONTROL_PLANE` is refused by *name* whatever type it claims, so masquerading can't slip it. The allowlist lives in `contracts` so the CLI can predict admission from the same list the control plane enforces

## Why

The tell was the issue's own framing: "what passes" was an emergent property of what the denylist forgot to ban, so a builder couldn't predict admission and the platform couldn't say what it permitted. A denylist is open by default — every new Cloudflare binding type is admitted until someone remembers to ban it; an allowlist is closed by default and fails safe. Same shape as D-39's "state that can drift from enforcement is worse than no state": the permitted set had to become a written artifact, not a gap. Follow-ups this scopes *out*: the CLI still only assembles DO+d1 bindings (kv/queue/r2 from a hand-authored wrangler are dropped before upload — a CLI-completeness gap, not an admission one), and structural D1-ownership proof is #301
