---
"@substrat-run/contracts": minor
"@substrat-run/kernel": minor
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/contract-tests": minor
"@substrat-run/control-plane-api": minor
"@substrat-run/control-plane": patch
"@substrat-run/console": patch
---

After a promote, a scope now asks for its provision reconcile on its next wake instead of waiting for the batched pass (K-69, step 5 of the tenant-scale RFC). The first time a scope object runs its migration pass on a version it has not asked about, it writes one `provision-reconcile` intent into its own journal, once per version, never from a copy, never after a failed migration, and never into a full journal. The response that woke it flags a drain, and the control plane reconciles the scope against the version it runs if the directory says it is behind, with the batched pass's own rule, reach and receipt. `PROVISION_RECONCILE_ON_WAKE=off` turns the handler into a no-op, and the batched pass (`PROVISION_RECONCILE_BATCH`) stays on beside it for now. Staff read how far a vertical's installs have come at `GET /verticals/:slug/reconcile-progress`, idle installs included, and the console shows it on the vertical's page. Contracts adds `PROVISION_RECONCILE_KIND`, `provisionReconcilePayload`, `provisionReconcileResult` and `reconcileProgressReading`. The kernel adds `provisionReconcileTarget` and `reconcileProgressOf`, and refuses `provision-reconcile` from module code. The control-plane API adds `provisionReconcileHandler`, `reconcileOnWakeEnabled`, `readReconcileProgress` and the staff client's `readReconcileProgress`.
