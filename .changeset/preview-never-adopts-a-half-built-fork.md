---
"@substrat-run/control-plane-api": patch
---

fix(previews): a retried `preview create` re-forks, instead of adopting the empty leftover

A preview only holds data once its two-phase create finished: the directory row lands first
as `provisioning` (K-31), the fork's export→restore runs against the PR version's
deployment, and `activateScope` is the **last** step. A create that died in the data copy
therefore leaves a `provisioning` row over an empty DO.

`orchestratedPreview` matched an existing preview on `(kind, slug)` alone, so the next
create adopted that row and took the **reuse** branch — which rebinds the version, renews
the TTL and binds the hostname, but never copies data. The preview came back
`reused: true`, CI printed `✓ preview '<tag>' updated … against a fork of prod`, and the
reviewer got a URL onto an empty database. The generated CI workflow retries
`preview create` on a transient, so this was the *common* path, not a corner: attempt 1
forks and dies, attempt 2 adopts its corpse and goes green.

Reuse now requires `status === 'active'`. A half-built leftover is reaped (DO bytes in its
own deployment, then the directory row and its `--<tag>` hostname) and the create falls
through to a fresh fork — which is what the retry was asking for. `refresh: true` takes the
same path, fixing a second bug on the way: its fresh scope used to collide with the old
row's still-bound hostname (`hostname '…' is already bound to another scope`).
