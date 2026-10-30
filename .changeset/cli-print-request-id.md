---
'@substrat-run/control-plane-client': minor
'@substrat-run/cli': minor
---

A failed control-plane call exposes the request id the plane stamped (`ControlPlaneError.requestId`), and the CLI prints it as a `request id:` line after the error.
