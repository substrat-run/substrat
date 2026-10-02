---
"@substrat-run/control-plane-api": minor
---

Add `ControlPlaneStaffClient`, the typed client for the control plane's staff surface (tenants, scopes, fleet and log reads, the vertical registry), and a browser-safe `@substrat-run/control-plane-api/browser` entry that exposes it. It shares one transport with `ControlPlaneClient`, so both raise the same `ControlPlaneError` and read a problem document the same way. `ControlPlaneClient` is unchanged: same requests, same headers, same error.
