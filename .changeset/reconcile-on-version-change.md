---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/control-plane-api': minor
---

A push now repairs its own installs. A scope records which version its provision hook last ran against (`provisionedVersionId`), and the platform sweep re-runs the provision for any scope serving code that hook has never seen — so a vertical that starts minting a new service principal reaches the installs that predate it, instead of failing on them forever. `HostAdmin.markScopeProvisioned` is the receipt; both adapters carry it and the contract suite holds them to the same behaviour.
