---
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/cli': minor
---

A version's declared delegations travel in its permission registry: `substrat push` refuses a delegated key no module declares or one reserved to a system principal, the permission digest moves when a delegation changes (and stays put for a vertical that declares none), the promote diff lists each change by actor, keys and channels, and the control plane serves them on a version's flow.
