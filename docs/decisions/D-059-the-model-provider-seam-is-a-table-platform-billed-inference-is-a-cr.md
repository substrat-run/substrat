---
id: D-59
date: 2026-08-29
layer: plan
title: "The model-provider seam is a table; platform-billed inference is a credential-resolution rule, not a provider"
status: accepted
aliases: []
amends: [D-30]
tracking: ["#1054"]
---
# D-59 — The model-provider seam is a table; platform-billed inference is a credential-resolution rule, not a provider

**The platform provides the model, and it does so without a provider of its own.** The seam
D-18 named — "model providers are an adapter; the governance (metering, PII rules, audit) is
kernel" — is built as [#1054](https://github.com/substrat-run/substrat/issues/1054), and its
shape is a **table**, not a gateway: the builder studio's `PROVIDERS` row set, promoted to
`@substrat-run/model-providers`, where every provider is one row (`direct` = an AI SDK package,
`compatible` = an OpenAI-dialect endpoint) carrying its credential variables, its endpoint, its
hosting disclosure (vendor, location, what is sent — D-53/D-54 as data), and whatever its endpoint
wants per request. Cloudflare is an ordinary `compatible` row on par with Anthropic, Scaleway or
any other; its gateway features — attribution metadata, payload retention off, spend limits — are
**properties of that row** (`catalog`, `wire`, `request`), dispatched on those fields and never on
its name. A host differs from another only in *where credentials come from* and *how direct
packages get loaded*, and both are parameters of `createModel(spec, env, { factories })`.
**Governance is one host-layer wrapper**, `createModelHost` in `@substrat-run/vertical-host/model`:
resolve against **platform-held** credentials, consult the host's policy before the bytes go out,
run, and produce one `ModelUsageLine` — token counts as the provider *reported* them
(`reported: false` and zeros when it reported none, never an estimate that becomes a bill), list
price from the generated rate card **on our side** (`null` = unpriced, never $0), and five fixed
attribution keys `tenant / scope / vertical / version / operation`. It lives **around** operations,
never on `OperationContext`: a model call is a multi-second round-trip and no scope transaction may
span it. **Platform-billed vs bring-your-own-key is a credential-resolution rule**, not a second
provider: the tenant's own credential wins when they hold one, the platform's serves otherwise, and
the same row runs either way. **Meter 3 becomes computable for this one kind of usage**, amending
D-30's "meters 3 and 4 are uncomputable": every line is raised as a `model-usage` platform intent
and drained into the directory's `_substrat_model_usage` ledger — idempotent on the intent id,
refused if attributed to any tenant, scope or vertical other than the drained one — which is
exactly the cross-tenant fan-in D-30 said the outbox lacked, for exactly this. The platform's rate
is `list × (1 + margin)`, one global whole-percent margin applied at **read** time
(`MODEL_MARGIN_PERCENT`, default 20), so a margin change re-prices a window consistently and no
row ever carries two rates. "Meter, don't bill" still holds: the ledger is what an invoice
reconciles against, not the invoice.

## Why

The decision was forced by a comment. ticket0's assistant took a per-install Workers AI token,
and the manifest said why: *"billed to the account above — which is why it is per-install and
never a deployment-wide binding."* That was the honest description of a hole — the platform had
no way to meter and charge inference, so the only safe credential was the tenant's own — and
filling the hole with a Cloudflare-shaped feature would have been the wrong repair twice over.
Once because D-18 had already placed model providers in bucket 2 (adapter, swappable) and D-50 had
already made the builder provider-pluggable at the generator seam, so a "Cloudflare AI" capability
would have introduced a second, narrower seam beside a wider one that existed; and once because
D-54 makes the provider a disclosed subprocessor the tenant may constrain, which only works if
switching provider is a row change and not a code path — EU-resident inference (a Scaleway row)
answers a procurement objection by configuration exactly as D-54 promised only if it is *the same
mechanism* as the Cloudflare row. The user's constraint on the build — "keep Cloudflare dynamic
from the kernel's perspective, on par with Anthropic, Scaleway or any other provider" — is the
same point from the other side. Two consequences follow that are worth writing down because each
is the cheap way to get them wrong. First, *the rate card prices every row on our side*: a
provider's own cost field (Cloudflare's per-request `cost`) is a reconciliation source, never the
ledger, because a ledger that trusted one provider's arithmetic would be a different ledger for
that provider. Second, *the attribution is exactly five keys* because the smallest per-request
metadata limit among the rows we route through is five, and a sixth key does not fail — it drops
silently on the wire and breaks the reconciliation join for that provider only; so the schema is
`.strict()`, the gateway header builder refuses a sixth, and the fifth key is `version` rather
than `install` because `scope` already identifies the install and the version is what a cost
change correlates with. Placing the host *around* operations rather than adding `ctx.model` is
D-27 applied: ticket0 is the first consumer, the builder the second, and neither needs the kernel
seam yet; holding a scope's transaction open across a provider round-trip would also be the
no-network-in-module-code rule broken from the inside. The honest limits: bring-your-own-key is
*specified* by this decision but not *built* — hub credentials are sealed platform-side and only
platform-run connectors see them, so a tenant's key cannot reach a vertical-side host, and BYOK
needs the model call to run platform-side (connector-shaped) — and the gateway-log reconciliation
job is not started. Both stay on #1054 rather than being read into the decision as done.
