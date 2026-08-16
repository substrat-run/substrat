---
"@substrat-run/kernel": minor
"@substrat-run/adapter-cloudflare": patch
"@substrat-run/adapter-sqlite": patch
"@substrat-run/contract-tests": patch
---

Install grants an entitlement key the manifest can actually match, and a denied operation names both sides of the gap.

**The fallback emitted an illegal key.** `installEntitlements` derives from the
vertical's slug when nothing is declared — but a builder-pushed vertical's
registry slug is workspace-prefixed (`t-0wv2mwk4j5/crm-eff`), while
`manifest.entitlementKey` is `/^[a-z0-9-]+$/`. A slash is not a legal key, so
the fallback produced a value the thing it claims to derive from can never
equal: for a pushed vertical the granted and required keys could not agree, by
construction. The gate reads `manifest.entitlementKey` directly, so every gated
operation denied. The fallback now takes the slug's bare last segment, which
repairs already-pushed verticals on their next install without a re-push.

The mismatch was invisible until it wasn't. An un-projected scope trusts
upstream; the flip to strict enforcement is one-way and fires on the *first*
projection carrying entitlements — a fan-out, a reconcile, a re-provision. So a
bad key planted at install detonates arbitrarily later, triggered by something
unrelated to installing. That is what made the 2026-08-15 Egeryds prod lockout
read as a sudden platform failure rather than a four-month-old typo.

**The denial now names required AND held keys**, expired ones marked, via a
shared `entitlementDenial()` in the kernel so the three gates (coordinator,
scope DO, SQLite adapter) cannot word it differently. Required-alone reads as
"buy the SKU" and sends an operator shopping; the Egeryds tenant *held* four
keys, just under names the manifest could never match, and required-vs-held
shows that near-miss at a glance. Marking expiry separates "you had it, it
lapsed" from "you never had it" — different fixes. The extra read happens only
on the failure path; the hot path is unchanged.

Not changed: a required key going ungranted still does not fail the install. A
composed engine's key being absent is a legitimate SKU gate — a tenant on
workorder but not absence is a valid state — and the platform cannot tell that
apart from the vertical's own key being missing.

A vertical whose `entitlementKey` diverges from its slug must still declare
`substrat.entitlements` in package.json; the manifest never reaches the control
plane, so no derivation can guess it. That escape hatch is now documented in
marketplace-publish.md, along with the fact that every engine a vertical
composes adds a key.
