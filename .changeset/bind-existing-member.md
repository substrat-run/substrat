---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/vertical-auth': minor
---

A member who is already in a scope can now be bound to a record by a `bind` link (K-59), a third capability mode beside `act` and `become`. A holder of the binding's key on the record mints it for one named member with the hosts' new `mintBindLinkBounded`. It binds that member when their own session presents it: `exchangeCapability(…, { mode: 'bind', presenter })`. It is single use, its expiry is optional, and it is on the spine as the new `capability.bind-minted` and the record's unchanged `entity.holder-bound`. An unbind of the record, or the erasure of the member it names, revokes it. `vertical-auth` mounts it with `mountBindLinkRoutes`, and `contract-tests` adds `bindLinkContractSuite`.
