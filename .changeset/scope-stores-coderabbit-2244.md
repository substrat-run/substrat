---
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
'@substrat-run/cli': patch
---

A restore or an import that carries scope stores is refused before any write when the destination scope runs a vertical other than the one the host is pinned to, or when a store in the dump names no kind. Before, the pin was checked only after the scope's tables had been replaced or the scope created, and a store with no kind skipped the kind check. A Cloudflare host with no control plane now exports, imports and wipes a scope's stores under the vertical it was given. Before, each of these refused because it read a directory the host does not have. None of the three is refused on a scope that is not active: a reap backs up and wipes an archived scope, and a snapshot or a full pull may copy a suspended one. `substrat scope pull` writes a pull that carries scope stores as the `.dump.json`, so restoring it restores the stores too, and removes a `.sqlite` an earlier pull of the same scope left. A `.sqlite` file holds only the scope's tables.
