# k3s-sharding spike

Evidence for [#1638](https://github.com/substrat-run/substrat/issues/1638): can scopes be
sharded across processes, with one writer per scope, the way a Durable Object gives us one
for free? This is **layer 1 of the issue only**: N shard processes on one machine, no
cluster. Layers 2 (k3d in a GitHub Actions job) and 3 (real nodes) are not here.

**The answers are in [FINDINGS.md](FINDINGS.md).** Its first section says what this does
*not* show. Most importantly, the issue's "the multi-process host passes
`scopeHostContractSuite` unchanged" is not shown: the suite runs unchanged against the host a
shard builds, in one process, and the process boundary is shown by the cluster tests instead.

```
pnpm --filter '@substrat-run/spike-k3s-sharding^...' build   # the workspace packages it imports
pnpm --filter @substrat-run/spike-k3s-sharding test           # deterministic; what CI runs
pnpm --filter @substrat-run/spike-k3s-sharding test:cluster   # the multi-process runs, opt-in
```

`test` is what CI's affected selection picks up whenever a change reaches the kernel, the
sqlite adapter, the todo demo or the contract suites. Nothing in it races real time: the lease
and contract files run the control plane on a manual clock. `test:cluster` drives real shard
processes with real lease TTLs and router timeouts. A loaded runner can move those timings,
so it is run on purpose (before changing anything under `src/`), not on every PR.

This is the one spike that is a workspace member, because its evidence is a vitest suite
over the workspace kernel, adapter and contract suites.

## What runs

| process | file | the issue's mapping |
|---|---|---|
| control plane | `src/control-plane.ts` | the 1-replica StatefulSet; here only its lease table |
| shard `todo-<i>` | `src/shard.ts` | one pod of the vertical's StatefulSet, with its own volume |
| router | `src/router.ts` | the router Worker + dispatch, without the hostname half |

A shard serves the real `todo` vertical (`demos/todo`) through a `SqliteScopeHost` per scope,
behind the lease checks in `src/fence.ts`. Each scope file carries the storage-side fence of
`src/storage-fence.ts`, which refuses a stale holder's write inside its own transaction. `test/cluster.ts` spawns all of them on localhost and also plays the
scheduler's part (`restart()` brings a pod back under the same name, port and volume).

## Tests

| file | set | question | what it holds |
|---|---|---|---|
| `test/placement.test.ts` | test | 1, 4 | rendezvous hashing: agreement, spread, 1/(N+1) moved on scale-up |
| `test/lease.test.ts` | test | 2 | the lease table and the guard, against the control-plane process, on manual clocks |
| `test/storage-fence.test.ts` | test | 2 | a stale epoch's writes refused in-transaction, emitting or not |
| `test/process.test.ts` | test | — | the sentinel kills a child frozen when its runner dies |
| `test/contract.test.ts` | test | — | `scopeHostContractSuite`, unchanged, through the lease layer (in-process; see FINDINGS.md) |
| `test/kill.test.ts` | cluster | 2 | freeze, failover, wake, SIGKILL mid-write: no acknowledged write lost or doubled, and the woken holder's commit refused by its own files; plus the `LEASES=off` control, which must lose writes |
| `test/router.test.ts` | cluster | 1, 2 | a keyless write is never replayed; a holder paused for less than its lease is asked again |
| `test/background.test.ts` | cluster | 6 | per-scope background slots exactly once across a freeze, a handover and a SIGKILL |
| `test/reshard.test.ts` | cluster | 4 | 2 → 3: only the scopes whose home moved move, with all their writes |
| `test/control-plane-loss.test.ts` | cluster | — | the lease table lost: writes refused, nothing reseeded or deleted |

Every fault is fired by the shard on itself at an exact point (`arm()` in the harness), so
no sleep decides the order of a run. Every spawned process exits with its parent and within
a bounded lifetime. A sentinel kills it if its runner dies while it is frozen
(`src/process.ts`), and `Cluster.stop()` fails the run if anything survives it.

## Not here

The k3d job, images, manifests, MinIO, Litestream, cert-manager, multi-arch builds, and
everything in the issue's layer 3. The directory as a separate service (question 5): each
scope here carries its own slice of the directory, which FINDINGS.md names as the wrong
answer for production.

Nothing here is proposed as final API. Per the spikes convention, this directory is kept
only while an argument cites it.
