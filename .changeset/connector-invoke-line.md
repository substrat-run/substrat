---
'@substrat-run/kernel': minor
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/control-plane-api': patch
'@substrat-run/dashboard': patch
---

A connector's call into an app (`/internal/connector-invoke`) now writes one invocation line, of the new kind `connector`, so the app's Logs list each record a connector landed or failed to land (#3235). The line carries ids, the operation, `connection` as who it ran as, the outcome, the kernel's problem code and what the operation emitted, by count and type; never the provider's input or the error's text. adapter-cloudflare writes it from `connectorInvokeLocal`, so an app writes it once it is built against this release. control-plane-api: `connector` is a value of the `kind` facet. dashboard: the Logs page names it "connector call".
