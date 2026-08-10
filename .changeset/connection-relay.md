---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane': minor
---

feat(control-plane): the connection relay — a tenant admin connects a provider from the vertical's own UI

`POST /internal/connections/upsert` (connections.md §3.5.2), mirroring the email relay
(#303): a hosted CP-less vertical permission-checks the act with its own `ctx.check`,
returns the pasted credential as a harness-side effect, and the harness POSTs it to the
control plane, which re-derives the vertical from its own scope record (the shared
`PLATFORM_SECRET` never says which vertical), seals the secret with the platform's
`SecretBox`, and applies any requested `grantToConnection` grants on the calling scope.
Upserts are keyed (tenant, vertical, provider, externalAccountRef): a live connection is
rotated **in place**, so the connection id — and every grant tuple keyed on it — survives
rotation, making credential rotation self-serve. Attribution follows §3.5.1 on both paths:
`createdBy` on create, and a new additive `opts.rotatedBy` on
`HostAdmin.updateConnectionSecret` that lands in the audit metadata on rotate — the tenant
principal, never laundered into the platform actor. New contracts:
`connectionRelayRequest` / `connectionRelayResult`; new export
`relayConnectionUpsert` from `@substrat-run/control-plane-api`.
