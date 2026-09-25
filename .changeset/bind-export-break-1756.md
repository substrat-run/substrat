---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/cli': minor
'@substrat-run/dashboard': patch
---

Binding one app to a version is now refused when that version stops exporting an event type another app in the same tenant imports, the same way a promote already is. Without it, updating one app could stop another app's events arriving, and nobody would have agreed to that.

The refusal counts what would break. Pass `acknowledge: { exportBreak: true }` to bind anyway. The control plane's bind route (`POST /tenants/:t/scopes/:s/version`) takes it and, when it refuses, also lists the affected apps. `substrat scope bind` takes `--ack-export-break` and prints the list. The dashboard's Update and Bind show the refusal and ask before sending again with the acknowledgement. The admin log records an acknowledged bind.

A bind is judged by the code the app runs before and after it. An app on its vertical's serving script runs the served version whatever its pointer says, so re-pointing it is never refused; the promote that replaced that script already judged every tenant. A fork, a preview, and an app's first bind are never refused either, and neither is a bind that moves an app to another vertical.

`HostAdmin` gains `bindingImpact(actor, tenantId, scopeId, versionId)`, which lists the apps a bind would break, and `bindScopeVersion`'s options gain `acknowledge`. Anything that implements `HostAdmin` needs the new method. The kernel exports `bindExportBreaksOf` and the refusal helpers, and `exportBreaksOf` takes an optional `tenantId`.
