---
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': minor
---

The hosted-vertical sandbox is a positive binding allowlist, not a denylist (#302).
`assertSandboxContract` used to refuse a known-bad shortlist — `CONTROL_PLANE`, `service`
bindings, cross-script DO — and allow **everything else by omission**: KV, Queues, R2, and
analytics were never named or validated, and an unrecognized binding type sailed straight
through. "What passes" was an emergent property of what the denylist forgot to ban, so a
builder couldn't predict admission and the platform couldn't say what it permitted.

Inverted: a vertical may now declare only its OWN resources, from one written set —
`ADMISSIBLE_BINDING_TYPES` in `@substrat-run/contracts`, so the CLI can predict admission
from the same list the control plane enforces. Permitted are its `durable_object_namespace`
(own class only — no `script_name`, `class_name` ∈ declared `doClasses`) and own data stores:
`d1`, `kv_namespace`, `queue`, `r2_bucket`, `analytics_engine`, plus inert `secret_text` /
`plain_text` config. Anything else is refused **by omission**, with a message that names the
offending binding and its type and points at self-serve-deploy.md §4.1.

Two posture calls, now documented rather than incidental: own→own **`service` bindings stay
rejected** (a hosted vertical is one serving script — no own sibling to bind, and platform
reach is the router, K-27); own **`d1` stays admitted**, but its `database_id` ownership is
still unproven and trusted under model-B human admission until platform provisioning injects
the id (#301). `CONTROL_PLANE` is refused by **name** whatever type it claims, so a
masquerading binding can't slip through the type check.

`type` stays a free string at the schema layer on purpose: a refused type produces a named,
actionable rejection instead of a generic Zod parse error. Decision D-40; §4.1 enumerates the
full permitted/rejected/why table.
