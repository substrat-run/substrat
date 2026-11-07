---
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/vertical-host': minor
---

contracts: `codeForRefusalStatus` (the code a status-only refusal carries, never moving its status) and `problemCodeOf` (the taxonomy code a parsed refusal body declared).
control-plane-api: `ConnectionRelayError` and `ConnectUrlRelayError` carry the `code` their status does, and their refusals answer with it.
vertical-host: the connection, connect-url, connect-link and mail-in errors expose the platform refusal's code as `problemCode`, and read its sentence with `problemDetail`.
