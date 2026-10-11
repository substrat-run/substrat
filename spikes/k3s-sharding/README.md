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
pnpm --filter @substrat-run/spike-k3s-sharding test
```

This is the one spike that is a workspace member, because its evidence is a vitest suite
over the workspace kernel, adapter and contract suites.

## What runs

| process | file | the issue's mapping |
|---|---|---|
| control plane | `src/control-plane.ts` | the 1-replica StatefulSet; here only its lease table |
| shard `todo-<i>` | `src/shard.ts` | one pod of the vertical's StatefulSet, with its own volume |
| router | `src/router.ts` | the router Worker + dispatch, without the hostname half |

A shard serves the real `todo` vertical (`demos/todo`) through a `SqliteScopeHost` per scope,
behind `src/fence.ts`. `test/cluster.ts` spawns all of them on localhost and also plays the
scheduler's part (`restart()` brings a pod back under the same name, port and volume).

## Tests

| file | question | what it holds |
|---|---|---|
| `test/placement.test.ts` | 1, 4 | rendezvous hashing: agreement, spread, 1/(N+1) moved on scale-up |
| `test/lease.test.ts` | 2 | the lease table and the guard, against the control-plane process |
| `test/kill.test.ts` | 2 | freeze, failover, wake, SIGKILL mid-write: no acknowledged write lost or doubled; plus the `LEASES=off` control, which must lose writes |
| `test/background.test.ts` | 6 | per-scope background slots exactly once across a freeze, a handover and a SIGKILL |
| `test/reshard.test.ts` | 4 | 2 → 3: only the scopes whose home moved move, with all their writes |
| `test/contract.test.ts` | — | `scopeHostContractSuite`, unchanged, through the fence (in-process; see FINDINGS.md) |

Every fault is fired by the shard on itself at an exact point (`arm()` in the harness), so
no sleep decides the order of a run. Every spawned process exits with its parent and within
a bounded lifetime (`src/process.ts`), and `Cluster.stop()` fails the run if anything
survives it.

## Not here

The k3d job, images, manifests, MinIO, Litestream, cert-manager, multi-arch builds, and
everything in the issue's layer 3. The directory as a separate service (question 5): each
scope here carries its own slice of the directory, which FINDINGS.md names as the wrong
answer for production.

Nothing here is proposed as final API. Per the spikes convention, this directory is kept
only while an argument cites it.
