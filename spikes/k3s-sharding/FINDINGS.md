# Findings: scopes sharded across processes (#1638, layer 1)

Answers to questions 1, 2, 4 and 6 of #1638, from the code and tests in this directory.
Layer 1 only: processes on one machine, no cluster. Layers 2 (k3d in CI) and 3 (real
hardware) were not attempted. Questions 3 and 5 are open; what this run says about them is
at the end, along with the safety assumptions everything here rests on.

## Read this first: what is NOT shown

**The issue asks for "the multi-process host passes `scopeHostContractSuite` unchanged".
Layer 1 does not show that.** What it shows is narrower:

- `test/contract.test.ts` runs the suite unchanged (all 427 tests) against the host a shard
  builds: a `SqliteScopeHost` behind the lease layer (`src/fence.ts`), with its leases taken
  from the real control-plane process over HTTP. Every operation the suite invokes goes
  through the lease's admit and re-check; the file counts them, so the wrapper cannot pass by
  wrapping nothing. That proves the lease layer breaks no part of the contract. It runs in the
  test process, against one host, on a stopped clock, and without the storage-side fence
  (§2), which needs a shard's placement to stamp the files.
- The process boundary is shown by the cluster tests instead (`kill`, `router`,
  `background`, `reshard`, `control-plane-loss`), which drive real `todo` operations through
  real routers to real shard processes.

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
it does not hold answers `421 {holder, retryAfterMs}`, and the router goes to the holder.
That includes a holder the router had just given up on after a timeout: a live lease means
that shard is slow rather than gone, so the router asks it again with a growing backoff
(`test/router.test.ts`: a 700 ms pause against a 400 ms attempt timeout is answered by the
same holder at the same epoch). A stale or divergent router therefore costs hops and never a
write. The kill test runs a router that misses a whole failover, and it is turned away.

A placement table in the control plane is not needed for routing. The table that does exist
is the lease table, and it holds the one fact a hash cannot give you: which node's volume has
the latest copy (`data_on`).

Measured (`test/placement.test.ts`, 6000 scopes): 4 members each get 1500 ± 10 %, and any
router agrees with any other whatever order it lists the members in.

## 2. Single writer: what is the lease, and who fences a stale holder?

**The lease** is a row in the control plane: `(scope, holder, epoch, expires_at, data_on)`
(`src/control-plane.ts`). Each change is one `BEGIN IMMEDIATE` transaction, so two shards
racing for a scope get one winner, and the epoch goes up. Expiry is on the control plane's
**monotonic** clock (see the assumptions below). TTL 2 s in the cluster tests, renewed
every 400 ms.

**The holder is a process incarnation (`todo-1/<boot id>`), not the pod name.** This was
found by a failing test, not reasoned out beforehand. With the pod name as the holder, the
StatefulSet's replacement `todo-1` inherited its dead predecessor's unexpired lease simply by
having the same name. That is harmless when the predecessor really is dead. It is a
split brain when it is not, which is exactly the `kubectl delete pod --force` case: Kubernetes
starts the replacement without confirming the old pod has stopped.

**The stale holder is fenced by the scope's own files, inside its own transaction**
(`src/storage-fence.ts`). Every SQLite file of a scope carries one row, `_k3s_fence(epoch)`.
Every table carries INSERT, UPDATE and DELETE triggers that abort when the writing
connection's `k3s_holder_epoch()` is not that epoch. `k3s_holder_epoch()` is a SQL function
each shard registers on its connections, answering the epoch under which that process holds
the scope. A takeover stamps the new epoch into the previous holder's files, under their
write lock, before it copies them. A holder that wakes from a freeze and tries to commit
aborts at its first write. In the kill test, the woken holder's `w4` is **absent from its own
files**, not merely unacknowledged.

- **Every table, not the outbox.** The host guarantees no row per invocation: an event is
  written only if the handler emits one, and the idempotency record only when the caller sent
  a key (the `BEGIN IMMEDIATE` … `COMMIT` of `invoke` in
  `packages/adapter-sqlite/src/index.ts`). A fence on the outbox would let a non-emitting
  write through, so the triggers sit on every table. `test/storage-fence.test.ts` refuses
  both an emitting operation and a write that emits nothing, and lets the new epoch's holder
  write.
- **What it does not cover.** Tables are fenced when they exist at stamp time, which is
  after the host migrated the scope. A table a later migration adds is unfenced until the
  next stamp. Virtual tables and their shadow tables carry no triggers; their writes follow
  writes to tables that do.
- **How the function reaches the host's connections.** `SqliteScopeHost` opens its own
  connections and offers no hook, so the shard patches better-sqlite3's `prepare` and `exec`
  to register the function on a connection's first statement, the way
  `tools/vitest/like-pattern-limit.cjs` installs its limit. That demonstrates the mechanism a
  real adapter would build into its own connection. It is not a drop-in.
- **The fence row guards itself.** `_k3s_fence` carries its own INSERT, UPDATE and DELETE
  triggers. They refuse any change from a connection the stamp did not open (a second
  function, `k3s_stamping()`), so a stale holder cannot write its own epoch into the row and
  then write past it. The stamp only ever raises the epoch, and an older takeover is told it
  is stale. No trigger stops DDL: code that drops the triggers or the table. A real adapter
  reserves the name, as `ctx.sql` reserves `_substrat_*`. The spike does not.
- **Where it was shown: one filesystem, and only there.** Every "node-local volume" here is a
  directory on the same filesystem, so the new holder can open the old holder's *live* files
  and take their write lock. That is the shared-storage case with working locks, and it is
  the only case the fence was shown in. **In a cluster with genuinely node-local volumes, a
  live old holder's volume is not reachable from the new node, so the stamp never reaches the
  stale holder.** The copy would come from a reattach, which needs the old node off the
  volume first, or from a replica, where the stamp lands on the replica and not on the
  zombie's file. In that shape the fence as built protects nothing. Safety there rests on the
  lease, on the holder withholding its acknowledgement, and on the stale commit landing in a
  copy nobody serves. The "source is quiescent during the copy" argument (§4) does not apply.
  What such a deployment would need, and this spike did not prove: a fence at the storage
  the holder actually writes to. Either the volume is revoked before it is reattached
  elsewhere (detach, or multi-attach protection, at the storage layer), or every commit is
  checked against the lease where the data lives.

**The holder also checks its own lease, twice per invocation** (`src/fence.ts`). Before the
invocation it admits only under a grant whose `validUntil` has not passed. `validUntil` is
measured on the holder's monotonic clock from when the acquire or renew was sent, minus a
margin, so it falls before the control plane's own expiry. Past it, the holder renews, and a
refused renewal means the epoch moved. After the invocation, if `validUntil` passed while it
ran, the result is withheld (`503`). These checks keep a stale holder from serving and from
acknowledging. The storage fence is what keeps it from writing.

**The kill-mid-write test** (`test/kill.test.ts`, opt-in, see below) uses two shards and
three routers. Faults are fired by the shard on itself at exact points, so no sleep decides
the order. `todo-0` freezes (SIGSTOP) mid-write; one router waits on it and another fails
over; `todo-0` wakes and its commit is refused by its own files; a third, stale router sends
it a fresh write and is turned away; then `todo-1` is SIGKILLed after committing a write and
before answering it, and is restarted. Every acknowledged write must be present exactly once,
through every router.

- Before the lease existed (commit `b738dc92c`) it failed: the woken holder kept serving its
  stale copy, and two writes `todo-1` had acknowledged were lost. The control (`LEASES=off`:
  no lease, no fence) keeps that failure reproducible, and asserts that without the fence the
  woken holder's commit lands in its own files.
- With the lease and without the storage fence's stamp on the source, the woken holder's
  `w4` lands in its own files and the test is red. With the triggers made inert, the kill
  test and both refusals in `test/storage-fence.test.ts` are red.
- Removing the holder's after-check made the kill test red before the storage fence existed.
  Removing its before-check alone does not, because the background renewal fires as soon as
  the holder wakes and drops the grant first. `test/lease.test.ts` holds that check on its own.
- **A holder frozen INSIDE its write transaction** (fault point `in-tx`, between the
  kernel's `BEGIN IMMEDIATE` and its insert) holds the scope file's write lock for as long as
  it is frozen. The takeover's stamp cannot take that lock: it waits 1 s, gives up with a
  retryable `421`, and the router asks again. In the test variant, frozen for 8 s (four
  TTLs), nothing is lost or doubled. The woken transaction commits before the stamp can run.
  Its acknowledgement is withheld because its lease ran out, and the copy taken after the
  stamp carries it, so the retry under its key is a replay. **But the scope is unavailable
  for the whole freeze (8093 ms), not one TTL.** Safety holds; liveness is bounded only by
  how long the old holder keeps the lock, which only stopping it can bound. Without the
  retryable answer, the client got the stamp's 500 instead (red).
- **A SIGKILL alone cannot make this test fail on one machine.** A dead process writes
  nothing, `SqliteScopeHost`'s `_host.lock` already refuses a second process on the same
  directory (and dies with the process), and the retry is recognised by its idempotency key.
  The hazard the lease closes is a holder that is *not* dead: frozen, partitioned, or
  force-deleted and still running.

**Unavailability on a holder failure is the lease TTL, unless the holder is frozen holding a
write lock.** In the kill test, the write that hit the frozen holder and the one that hit
the killed holder were each answered in about 2.0 s with a 2 s TTL. A holder frozen *inside*
a write transaction keeps the scope unavailable for as long as it stays frozen (above). The
TTL is the dial for the rest: shorter means faster failover, more renewal traffic, and a
tighter clock requirement.

**Exactly-once needs the client's idempotency key, end to end.** A router that retries a
write after no answer cannot know whether it committed. Only the kernel's idempotency record
(#116) can tell, so the router forwards `Idempotency-Key` unchanged, and **never retries a
write without one** once it may have run: after a timeout or a `503` it answers with the
uncertainty instead (`test/router.test.ts`). A `421` is still followed, since the shard
refused before invoking anything. So the guarantee covers keyed writes. A keyless write is
applied at most once, and its caller may be told the outcome is unknown.

## 4. Resharding: N → N+1

**Consistent hashing bounds the move.** Rendezvous hashing moves only the scopes whose new
top weight is the new pod: about 1/(N+1) of them, all to the new pod (measured for N = 1, 2,
3 and 7 in `test/placement.test.ts`). Scaling down moves only the removed pod's scopes.

**The move is the lease's planned path** (`test/reshard.test.ts`, 2 → 3 with 8 scopes that
move and 16 that do not). Routers learn the new member list, and each shard releases the
scopes whose home moved: it finishes what is queued, releases the lease, and closes the
scope. The new home takes each scope on its next request (no TTL to wait out after a
release), stamps its epoch into the old copy (reachable here because it is on the same
filesystem, §2), and copies it from the volume `data_on` names.
Moved scopes answer from `todo-2` at epoch + 1 with every write; unmoved ones keep their shard
and epoch.

**The transfer is a file-level copy, not `snapshotScope` / `importScope`.** `copyScope` takes
each SQLite file through the online backup API, which snapshots each file consistently even
when its process was killed with a WAL never checkpointed. It carries everything in the
scope's directory without the kernel interpreting any of it. The backup API is consistent
per file, not per directory. On one filesystem the directory as a whole is consistent,
because the source was stamped before the copy and no holder can write any of its files while
they are read. Where the stamp cannot reach the source (§2), that argument is gone. The copy
never deletes anything: it is written into a directory `copyScope` creates and renamed into
place, and the stale copy it replaces is renamed aside (`<id>.superseded-<ms>`). It refuses a
source and destination that are, or contain, one another. Superseded copies accumulate; a
cleanup policy is not part of the spike.
`exportScope` / `importScope` remain the right tool across adapters (a Durable Object to
SQLite and back), where there is no file to copy. Between two SQLite shards they are a
slower, lossier path to the same bytes. Two things this does not settle: in a cluster the
copy is a volume reattach or a restore from a replica (question 3), and here the scope's
directory carries a slice of the directory database (question 5).

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

**Two limits of replaying from slot 0.** A new holding replays every slot since the scope's
birth, which is one invocation per slot per handover. And it is exactly-once only while the
keys are kept: the kernel prunes idempotency records after `IDEMPOTENCY_RETENTION_MS` (24 h),
and a handover after that would run old slots again. The real design keeps a durable
per-scope watermark. The kernel's schedule ledger is that watermark, and its own background
work (`drainDue`, the platform sweep, schedules) would sit where these slots sit, under the
scope's lease. The control plane's 15-minute tick is not per scope, so it stays a CronJob, as
the issue's mapping says.

## Safety assumptions, stated

What the guarantees above rest on. A real adapter has to make each one true, not assume it.

- **Bounded clock-rate drift between holder and control plane.** The holder stops at
  `validUntil`, measured on its own monotonic clock from when it asked, minus a margin. That
  is before the control plane can grant the scope elsewhere only if, over one TTL, the two
  clocks do not drift apart by more than the margin. True on one runner; a property of the
  nodes in a cluster.
- **Monotonic clocks, not wall clocks, for every TTL decision.** The control plane measures
  expiry on its monotonic clock, so an NTP step cannot expire every lease at once while
  holders still admit writes. A monotonic reading means nothing to the next incarnation, so a
  restarted control plane re-holds every lease for a full TTL before granting it to anyone
  else (`test/lease.test.ts`).
- **The lease table is at least as durable as the data.** It is the only record of the
  epochs and of `data_on`. The spike fails closed when it is lost
  (`test/control-plane-loss.test.ts`). A scope with no row is refused (`404`), never read as
  "new scope". A scope is created only by an explicit provision. A shard seeds only where its
  volume has nothing, opens its own copy only when the control plane names it and the copy is
  whole (an incomplete one is refused, `409`), and deletes no data directory at all: a copy it
  replaces is moved aside. Failing closed protects the data but not availability: every
  scope is unwritable until the table is restored. In production the table needs its own
  replication and backup, which belongs to questions 3 and 5.
- **Both holders reach the same files, under a write lock both honour.** That is what the
  storage fence needs, and it is what one filesystem gives. On a network filesystem or a
  shared volume it has to be checked. With node-local volumes in a cluster it is not true at
  all, and the fence as built does not apply (§2).
- **A frozen holder is eventually stopped.** The lease bounds how long a frozen holder keeps
  the scope only while it is frozen outside a write transaction. Inside one, it keeps the
  lock, and only stopping it ends the unavailability.
- **Writes carry idempotency keys.** See §2: a keyless write is applied at most once, and its
  outcome can be unknown to its caller.

## 3 and 5: open, with what this run showed

- **Q3, pod loss.** Layer 1 cannot answer this, because the "volume" of a dead shard is just
  a directory any process can read. What it does show is the shape of the cost: a scope is
  unavailable for a lease TTL plus the time to place its data, and placing it on another node
  needs the volume to reattach there or a current replica to exist. With an asynchronous
  replica (Litestream) the copy can lag, which is exactly the lost-write case the kill test
  catches, so a restore from a stream needs the lease and a replication watermark together.
  The lease table's own durability is part of the same question. This is the operational gap
  versus Durable Objects.
- **Q5, the directory.** The spike sidestepped it: every scope's directory carries its own
  slice of the directory database (tenant, roles, grants). With two scopes of one tenant on
  two shards, those slices disagree. It is also the reason the contract suite cannot cross
  the process boundary (see the top of this file), and the control plane that holds the
  lease table is the same service. Of everything here, it is the largest piece of work.

## Which tests run where

`pnpm test`, the set CI's affected selection runs: placement, lease, storage fence, the
process sentinel, and the contract binding. None of them races real time. The lease and
contract files run the control plane on a manual clock and move it explicitly.

`pnpm test:cluster` is opt-in: kill, router, background, reshard and control-plane loss.
They drive real shard processes through freezes and kills with real lease TTLs and router
timeouts, and a loaded runner can move their timings, so they are run on purpose rather
than on every PR. Both sets were run 20 times in a row for #2202.

## Changes to `platform-neutral-surface.md`

§5 says "a per-scope leader lease + a single-consumer queue + SQLite-on-a-PV satisfies" the
single-writer requirement. The amendment narrows that to what was run here: copy-on-takeover
between scope directories on **one filesystem**, where the new holder can lock the old holder's
live files. It names what the run needed: the holder as a process incarnation, a fencing
epoch checked inside the scope's own transaction on every table, and idempotency keys carried
end to end. It also gives the clock and durability assumptions above. It says that node-local
volumes in a cluster need a fence at the storage the holder writes to, which the spike did not
show, and that a holder frozen inside a write transaction keeps the scope unavailable for as
long as it is frozen.

## Estimate for the real adapter

**About a quarter, not a few weeks.** The parts built here (placement, lease, the storage
fence, router, handover) took a spike to show and are maybe three to four weeks to harden;
the fence in particular belongs on the adapter's own connection, not in a patch. What remains
is larger: the directory as a service with every `HostAdmin` call over the network (Q5); the
RPC `ScopeHost` facade and a code-time module set for the shards, which is what the contract
suite needs; executors and the platform sweep placed per scope; and Q3's volume story, which
cannot be judged without layers 2 and 3.
