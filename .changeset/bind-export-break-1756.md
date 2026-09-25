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

Moving one app onto a version that stops exporting an event type another app in the same tenant imports is now refused, the same way a promote already is. Before, updating one app could stop another app's events arriving, and nobody would have agreed to that.

A move is either of the two things that decide what code an app runs: binding it to a version, or routing it onto (or off) its vertical's serving script, which is what adopting a legacy app does before its version ever changes. Both are judged by the code the app runs before and after. An app that stays on the serving script runs the served version whatever its pointer says, so re-pointing it is never refused; the promote that replaced that script already judged every tenant. A fork, a preview, an app still provisioning, and an app's first bind are never refused either. A move to another vertical (`rebind-vertical` across lineages) is not judged, which is a known gap.

The refusal counts what would break. Pass `acknowledge: { exportBreak: true }` to move anyway, and the admin log records it.

- The control plane's bind (`POST /tenants/:t/scopes/:s/version`), `adopt-serving` (per app and vertical-wide) and `rebind-vertical` take `acknowledge`, ask before moving any data, and refuse with the affected apps listed. `GET /tenants/:t/scopes/:s/binding-impact?versionId=` asks the same question without moving anything.
- A private vertical's promote passes its own acknowledgement on to the apps it adopts. An app it never judged (not on the channel's previous version) is left where it is unless the promote was acknowledged, and the promote says so.
- `substrat scope bind`, `scope adopt-serving` and `scope rebind` take `--ack-export-break` and print the affected apps.
- The dashboard's Update and Bind list the affected apps in a confirm and send again acknowledged. A refused Update leaves nothing on the Activity trail, and an acknowledged one says it was acknowledged.
- A version that is not admitted is refused as that before any acknowledgement is asked for.

`HostAdmin` gains `bindingImpact(actor, tenantId, scopeId, versionId, opts?)`, which lists the apps a move would break (`opts.servingRef` for a routing move). `bindScopeVersion` and `setScopeServingRef` gain `acknowledge` in their options. Anything that implements `HostAdmin` needs the new method. The kernel exports `bindExportBreaksOf` and the refusal helpers, and `exportBreaksOf` takes an optional `tenantId`.
