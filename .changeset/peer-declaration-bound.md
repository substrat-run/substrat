---
"@substrat-run/kernel": patch
"@substrat-run/adapter-sqlite": patch
"@substrat-run/adapter-cloudflare": patch
"@substrat-run/contract-tests": patch
"@substrat-run/docs": patch
---

A peer now holds only what the version serving the scope declares for it. Narrowing a peer's entry in `peers`, or removing the peer, used to leave every existing install holding the old permissions, because provisioning only ever adds them. Now the first call after the promote no longer has a permission the running version dropped, on every install, with no reconcile needed. The grant an earlier version wrote stays in the scope as a record but counts for nothing, and switching the peer off and on again does not bring it back. Declaring the permission again makes it held again, and a grant a tenant took away stays taken away. The per-scope peer status read (`peerGrantsStatus`, what the dashboard's peer panel shows) follows the same rule: a peer that holds no permission the running version declares reads `ungranted` rather than `on`, and a switched-off peer still reads `off`. Both adapters evaluate every check through the new kernel export `boundToPeerDeclarations`. It fails closed: if the running declaration cannot be read, a peer holds nothing. `@substrat-run/contract-tests` adds the `peerModNarrowed` and `peerModWithoutCaller` fixtures. The peers section of `PERMISSIONS.md` and the permissions guide now say that a narrowing takes effect at promote.
