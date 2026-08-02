---
'@substrat-run/control-plane-api': patch
---

A dispatch/transport rejection on the vertical's `/internal/*` surface (a cold-starting
script, a DO reset, a missing dispatch entry) now surfaces as a `ControlPlaneError` 502
naming the verb and the runtime's own message — "vertical unreachable during configure:
…" — instead of propagating raw and collapsing to the API boundary's generic 500
"internal error" (#391). A non-ok response is unchanged: still the vertical's own
status and message. Callers can treat the 502 as the transient it usually is; the
dashboard's install step 3 now retries exactly this window.
