---
'@substrat-run/control-plane-api': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/cli': patch
---

A store that cannot be minted answers with a diagnosis, and no longer costs the caller the
reconcile (#828).

`substrat scope provision` — the lever #825's own deploy note prescribes — began answering
`500 {"error":"internal error"}` for every scope with a declared blob store. Three faults,
each of which was enough on its own.

**The R2 client was never constructed.** `createR2BlobStores` shipped with #473, was
exported, and was covered by tests against an injected fake; nothing in the deployed
control-plane worker ever called it. `hostFor` wired the D1 twin and stopped, so
`provisionBlobStore` refused on every real control plane while the suite stayed green — the
untested seam was the worker's own construction, not the client. It stayed latent until a
vertical first declared a blob store, which is exactly what #825 was filed for. Both clients
are now built together in one exported `platformStoreClients`, and the pairing is asserted:
a future store substrate has to appear there or the test fails.

**Minting is best-effort on the repair path, as it already is on promote.** #826 made
provision mint before reconciling, unwrapped — so a mint failing for reasons unrelated to
this scope (a credential without the permission, a client the deployment never configured,
the store API refusing) took the whole call down, and the caller lost the owner re-grant and
role re-projection they actually came for (#332). Each substrate is now attempted
independently, records an ops-failure row with its stage, and rides back as `storeError` in
the response, which `substrat scope provision` prints. The two paths finally agree about the
same operation's failure semantics. A *new* install keeps the fail-loud posture deliberately:
its store is handed into the K-31 ready-gate, so proceeding without one hands back a
half-built scope that reports success.

**"Not configured on this host" reaches the caller.** Both store refusals are now typed
`unavailable`, and `mapError` maps that code to 503 with the message intact — the same
treatment `SecretBoxUnconfiguredError` gets (#603), for the same reason: a deployment fact is
not a fault in the request, and the same request succeeds unchanged once the host is wired.
The message names what to configure, and the platform spent four hours answering
`internal error` to a provision while holding it.
