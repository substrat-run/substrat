---
'@substrat-run/vertical-host': patch
---

`/internal/reconcile` now runs the vertical's own `onProvision` hook after the kernel half, so a repair repairs everything a provision creates. Before this it re-projected roles and re-seated the owner and stopped, which meant anything a vertical mints for itself — service principals, a site registration — could never reach a scope that predated it: `/internal/provision` is called at install and never again. Hooks are already required to be idempotent, so this asks nothing new of one.
