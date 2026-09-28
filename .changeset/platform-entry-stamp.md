---
'@substrat-run/kernel': minor
'@substrat-run/vertical-host': patch
'@substrat-run/control-plane-api': minor
---

Every deployed vertical is now stamped by the platform. At upload, the control plane puts its own entry module in front of the vertical's bundle and wraps the default export with the kernel's new `withInvocationLog`, so each request writes its invocation line whether or not the vertical mounted `invocationLog`. The middleware still works and now steps aside when the platform has already stamped the request, so a request is logged once either way. A bundle built on an older kernel that writes the line itself is uploaded unwrapped. Operation routes and MCP tools read the platform's stamp when no middleware is mounted.
