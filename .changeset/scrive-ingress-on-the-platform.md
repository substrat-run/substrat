---
"@substrat-run/control-plane": patch
---

feat: the Scrive webhook ingress terminates on the platform (#574 phase 2, #96)

For a CP-less dispatch vertical the callback capability URL has nowhere to land:
the dispatch ledger the token verifies against lives in the control plane's
directory, out of any pushed script's reach — PR #573 deliberately stopped short
of mounting the ingress there. Phase 2 puts the door where the ledger is:

- The CP worker mounts `SCRIVE_CALLBACK_ROUTE`
  (`/hooks/scrive/:connectionId/:instanceId/:token`). Unauthenticated by design —
  Scrive signs nothing, so the per-dispatch minted token is the entire
  authentication, compared in constant time against the ControlPlaneDO-held
  ledger row.
- On a match the same `reconcileScriveDispatch` the sweep runs re-reads the
  provider's truth (the callback body is never read, let alone trusted) and
  records it back through the vertical's `/internal/connector-*` surface — the
  phase-1 write-back seam. Push collapses the poll floor's latency; it never
  replaces it.
- Every rejection is one uniform 404 with the reason only logged, so the
  response is no oracle for probing which instances exist, and nothing short of
  a verified token causes provider egress. A post-verification failure answers
  500 so Scrive retries.

Phase 3 (outbound dispatch via platform-requests) closes #574.
