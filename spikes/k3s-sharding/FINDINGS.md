# Findings: scopes sharded across processes (#1638, layer 1)

Answers to questions 1, 2, 4 and 6 of #1638, from the code and tests in this directory.
Layer 1 only: processes on one machine, no cluster. Layers 2 (k3d in CI) and 3 (real
hardware) were not attempted. Questions 3 and 5 are open; what this run says about them is
at the end.

## Read this first: what is NOT shown

**The issue asks for "the multi-process host passes `scopeHostContractSuite` unchanged".
Layer 1 does not show that.** What it shows is narrower:

- `test/contract.test.ts` runs the suite unchanged (all 427 tests) against the host a shard
  builds: a `SqliteScopeHost` behind the lease/fence layer (`src/fence.ts`), with its leases
  taken from the real control-plane process over HTTP. Every operation the suite invokes goes
  through the fence's admit and re-check (the file counts them, so the wrapper cannot pass by
  wrapping nothing). That proves the fence breaks no part of the contract. It runs in the
  test process, against one host.
- The process boundary is shown by the cluster tests instead (`kill`, `background`,
  `reshard`), which drive real `todo` operations through real routers to real shard
  processes.

Why the suite cannot run against a host whose scopes live in other processes:

1. **Its handlers are closures in the test process.** The suite registers executors and
   operations whose bodies capture its own state (for example an executor that pushes into
   an `effected` array the next assertion reads). A shard process cannot run a closure that
   lives in another process. The Cloudflare adapter has the same problem and solves it the
   expensive way: the DO closes over a code-time module set (`supportsRuntimeRegistration:
   false`), and its facade, ScopeDO and ControlPlaneDO add up to about 25 000 lines.
2. **It drives the directory on the same object as the scopes.** `host.admin` (tenants,
   grants, roles, audit) and the scopes are one `SqliteScopeHost`. With more than one shard,
   the directory has to be a service every shard calls. That is question 5.

What it would take: a `ScopeHost` facade that resolves a scope to its shard and forwards
`getScope(…).invoke` over RPC; the shards built over a code-time module set, as on
Cloudflare; executors and connectors run where the facade can see them, or the suite's
closures turned into fixtures a shard can load; and the directory as its own service (Q5).
That is the real adapter, not a spike. See the estimate at the end.

## 1. Placement: how is scope → shard decided and found?

**Rendezvous (highest-random-weight) hashing over the StatefulSet's stable pod names**
(`src/placement.ts`). It is a pure function of `(scopeId, members)`, so there is no
placement table and nothing for router replicas to agree on beyond the member list. The
output is an order: the first entry is the home, the rest is the failover order, and every
router computes the same one.

**Placement says where a scope should be. The lease says where it is.** The router caches
exactly one fact per scope, the shard that last answered for it. A shard asked about a scope
it does not hold answers `421 {holder, retryAfterMs}`, and the router goes to the holder or
waits. A stale or divergent router therefore costs a hop and never a write; the kill test
runs a router that misses a whole failover, and it is turned away.

A placement table in the control plane is not needed for routing. The table that does exist
is the lease table, and it holds the one fact a hash cannot give you: which node's volume has
the latest copy (`data_on`).

Measured (`test/placement.test.ts`, 6000 scopes): 4 members each get 1500 ± 10 %, and any
router agrees with any other whatever order it lists the members in.

## 2. Single writer: what is the lease, and who fences a stale holder?

**The lease** is a row in the control plane: `(scope, holder, epoch, expires_at, data_on)`
(`src/control-plane.ts`). Each change of holder is one `BEGIN IMMEDIATE` transaction, so two
shards racing for a scope get one winner, and the epoch goes up. TTL 2 s in the tests,
renewed every 400 ms.

**The holder is a process incarnation (`todo-1/<boot id>`), not the pod name.** This was
found by a failing test, not reasoned out beforehand. With the pod name as the holder, the
StatefulSet's replacement `todo-1` inherited its dead predecessor's unexpired lease simply by
having the same name. That is harmless when the predecessor really is dead. It is a
split brain when it is not, which is exactly the `kubectl delete pod --force` case: Kubernetes
starts the replacement without confirming the old pod has stopped.

**Fencing is done by the holder, against its own clock, twice per invocation** (`src/fence.ts`):

- before: admit only under a grant whose `validUntil` has not passed. `validUntil` is
  measured on the holder's monotonic clock from the moment the acquire or renew was sent,
  minus a margin, so it always falls before the control plane's own expiry. Past it, the
  holder renews, and a refused renewal means the epoch moved: it stops;
- after: if `validUntil` passed while the invocation ran, the result is withheld (`503`,
  `Fenced`). The write may have committed, but on a copy nobody will serve again, and the
  caller is not told it succeeded. It retries under its idempotency key, and the new holder
  applies it once.

**Who fences a stale holder, then?** The stale holder fences itself, and the control plane
makes sure that is enough: it grants the scope to someone else only after the old grant's
expiry, and the new holder copies the data only after that. The safety argument is the usual
one for leases: it assumes the holder's clock and the control plane's do not drift apart by
more than the margin during one TTL. On one machine that holds trivially. In a cluster it is
a property of the nodes and has to be stated as a requirement.

There is no storage-side fencing token in this design: no "refuse epochs below N" check
inside the scope's own transaction. `SqliteScopeHost` owns its transactions, so adding one
means a change in `packages/` that this spike was not to make. With node-local volumes it is
also not needed for the cases tested: a stale holder writes only to its own copy, which the
`data_on` pointer has already stopped naming. It would be needed with shared storage that
two nodes can write at once.

**The kill-mid-write test** (`test/kill.test.ts`) uses two shards and three routers. Faults
are fired by the shard on itself at exact points, so no sleep decides the order. `todo-0`
freezes (SIGSTOP) mid-write; one router waits on it and another fails over; `todo-0` wakes
and finishes the write on its stale copy; a third, stale router sends it a fresh write; then
`todo-1` is SIGKILLed after committing a write and before answering it, and is restarted.
Every acknowledged write must be present exactly once, through every router.

- Before the lease existed (commit `b738dc92c`) it failed: the woken holder kept serving its
  stale copy, and two writes `todo-1` had acknowledged were lost. The control
  (`LEASES=off`) keeps that failure reproducible permanently and asserts it.
- Each fence is held separately. Removing the after-check makes the kill test red (the
  woken holder's write is acknowledged and lost). Removing the before-check alone leaves the
  kill test green, because the holder's background renewal fires as soon as it wakes and
  drops the grant first. So that check is held by `test/lease.test.ts` on its own, and
  removing it together with the renewal makes the kill test red.
- **A SIGKILL alone cannot make this test fail on one machine.** A dead process writes
  nothing, `SqliteScopeHost`'s `_host.lock` already refuses a second process on the same
  directory (and dies with the process), and the retry is recognised by its idempotency key.
  The hazard the lease closes is a holder that is *not* dead: frozen, partitioned, or
  force-deleted and still running.

**Unavailability on a holder failure is the lease TTL.** In the kill test, the write that
hit the frozen holder and the one that hit the killed holder were each answered in about
2.0 s with a 2 s TTL (1915–2023 ms over three runs). The TTL is the dial: shorter means
faster failover, more renewal traffic, and a tighter clock-drift requirement.

**The idempotency key has to travel from the client, through the router, to the scope.** A
router that retries a write after no answer cannot know whether it committed. Only the
kernel's idempotency recording (#116) can tell, so the router forwards `Idempotency-Key`
unchanged and retries only with it.

## 4. Resharding: N → N+1

**Consistent hashing bounds the move.** Rendezvous hashing moves only the scopes whose new
top weight is the new pod: about 1/(N+1) of them, all to the new pod (measured for N = 1, 2,
3 and 7 in `test/placement.test.ts`). Scaling down moves only the removed pod's scopes.

**The move is the lease's planned path** (`test/reshard.test.ts`, 2 → 3 with 8 scopes that
move and 16 that do not). Routers learn the new member list, and each shard releases the
scopes whose home moved: it finishes what is queued, releases the lease, and closes the
scope. The new home takes each scope on its next request (no TTL to wait out after a
release) and copies it from the volume `data_on` names. Moved scopes answer from `todo-2` at
epoch + 1 with every write; unmoved ones keep their shard and epoch.

**The transfer is a file-level copy, not `snapshotScope` / `importScope`.** `copyScope` takes
each SQLite file through the online backup API. That gives a consistent snapshot even of a
file the source still has open, or of one whose process was killed with a WAL that was never
checkpointed, and it carries everything in the scope's directory without the kernel
interpreting any of it. `exportScope` / `importScope` remain the right tool across adapters
(a Durable Object to SQLite and back), since there is no file to copy there. Between two
SQLite shards they are a slower, lossier path to the same bytes. Two things this does not
settle: in a cluster the copy is a volume reattach or a restore from a replica (question 3),
and here the scope's directory carries a slice of the directory database (question 5).

## 6. Background work: exactly once per scope, on the owner, across a handover

**The loop runs only for scopes the shard holds, through the same fenced stub as a request,
and every unit of work carries an idempotency key** (`src/shard.ts`, `test/background.test.ts`).
The lease gives at most one runner at a time. The key turns at-least-once into once: a new
holder replays the slots the old one finished, and a slot the old one committed but never
recorded (killed in between) is a replay too. Removing the key doubles every slot in the test.

**Someone has to claim a scope nobody is asking about.** After its holder dies, a scope has
no holder until something asks for it, and a background loop that only covers held scopes
would never run its work. So each shard's loop also tries the scopes on its own volume: once
the dead holder's lease runs out, a restarted pod (or any other shard with a copy) takes the
scope back and carries on, with no request needed. In the test that happens after a freeze, a
handover, and a SIGKILL mid-slot, and every slot up to the last one seen is present exactly
once with no gap.

The slots in the test are a stand-in. The kernel's own background work (`drainDue`, the
platform sweep, schedules) would sit in the same place, with the same two requirements: run
it only under the scope's lease, and give each unit an identity that a replay can recognise.
The schedule ledger is the kernel's existing version of that identity. The control plane's
15-minute tick is not per scope, so it stays a CronJob, as the issue's mapping says.

## 3 and 5: open, with what this run showed

- **Q3, pod loss.** Layer 1 cannot answer this, because the "volume" of a dead shard is just
  a directory any process can read. What it does show is the shape of the cost: a scope is
  unavailable for a lease TTL plus the time to place its data, and placing it on another node
  needs the volume to reattach there or a current replica to exist. With an asynchronous
  replica (Litestream) the copy can lag, which is exactly the lost-write case the kill test
  catches, so a restore from a stream needs the lease and a replication watermark together.
  This is the operational gap versus Durable Objects.
- **Q5, the directory.** The spike sidestepped it: every scope's directory carries its own
  slice of the directory database (tenant, roles, grants). With two scopes of one tenant on
  two shards, those slices disagree. It is also the reason the contract suite cannot cross
  the process boundary (see the top of this file). Of everything here, it is the largest
  piece of work.

## Changes to `platform-neutral-surface.md`

§5 says "a per-scope leader lease + a single-consumer queue + SQLite-on-a-PV satisfies" the
single-writer requirement. The spike shows that it does, with three things the sentence did
not name: the lease holder must be a process incarnation rather than the pod name; the
holder must withhold an acknowledgement when its lease ran out during the invocation; and the
client's idempotency key must reach the scope through the router. The doc is amended with
that and a pointer here.

## Estimate for the real adapter

**About a quarter, not a few weeks.** The parts built here (placement, lease, fence, router,
handover) took a spike to show and are maybe three weeks to harden. What remains is larger:
the directory as a service with every `HostAdmin` call over the network (Q5); the RPC
`ScopeHost` facade and a code-time module set for the shards, which is what the contract
suite needs; executors and the platform sweep placed per scope; and Q3's volume story, which
cannot be judged without layers 2 and 3.
