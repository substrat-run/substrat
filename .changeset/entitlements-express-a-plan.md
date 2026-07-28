---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/console': minor
'@substrat-run/demo-callout': patch
---

Entitlements express a plan (#33): the two-column SKU flag grows `expiresAt`,
`quota`, `plan` and `grantedAt`/`grantedBy`. Expiry is the one field the kernel
itself enforces — an expired grant fails closed at the per-invoke gate exactly as
if revoked, checked lazily at read like tuple expiry (never swept), and the row
stays in `listEntitlements` so a lapsed trial reads as lapsed rather than
never-granted. Quota and tier are expression only, per the D-33 reframe: they
describe the builder's subscription, and counting usage against them is the
builder portal's job — which is why plan *expression* lands ahead of billing
(#39 stays blocked on meters). Grant calls are PATCH-shaped: omitted fields
preserve what the row carries (a bare re-grant on an idempotent provisioning
path cannot silently turn a trial perpetual), explicit null clears, and any
effective change is a renewal audited with before/after. `listEntitlements` now
returns `EntitlementGrant[]` instead of `string[]`; the PUT route accepts the
plan as an optional body (a bodyless PUT stays the bare-flag grant); both
adapters widen `_substrat_entitlements` with nullable columns via the existing
ensure-column path, so legacy rows read as perpetual boolean flags — exactly
their old semantics. The console shows and edits the plan half; Callout's boot
mirror forwards whole grants so the shared plane never sees a trial as
perpetual.
