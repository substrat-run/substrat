---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
---

A tenant-wide system grant for a module is now refused while the schedule kill switch has that module switched off on any scope of the tenant. Before, only a grant on one scope was checked, and a tenant-wide grant reached every scope, switched-off ones included. The refusal names the scopes that hold the module off; restore them first, and the same grant is accepted. A grant that already existed when a scope was switched off is not yet taken back by the switch (#1823).
