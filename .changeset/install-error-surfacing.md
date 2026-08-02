---
'@substrat-run/control-plane-api': patch
---

Install failures now say what the vertical said (#424 cases 1+2). A non-JSON refusal
body — the shape a foreign vertical or a runtime error page answers with — surfaces
verbatim (truncated at 500 chars) instead of collapsing to "vertical refused
provisioning: 503 Service Unavailable"; JSON `{error}` bodies pass through bare as
before. And the install endpoint rides out transient 5xx answers from the vertical on a
short backoff (the binding-attach → script-settings propagation race) instead of
surfacing a one-shot failure — honest refusals (4xx, 501) still fail immediately.
`provisionRetryDelaysMs` overrides the backoff for tests.
