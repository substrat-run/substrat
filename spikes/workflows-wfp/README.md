# Cloudflare Workflows held to the phase 1 rule

Evidence for [#3369](https://github.com/substrat-run/substrat/issues/3369), the phase 1 spike of
[the one-model RFC](../../docs/rfc/one-model-for-shipped-code.md) (§7.6, §8). Only the findings
are kept here. The experiment code is not: it ran from commit `4aea81311` of
[PR #3385](https://github.com/substrat-run/substrat/pull/3385), whose commit holds it (the toy
vertical, `run-local.mjs`, `probe.mjs` and the [runbook](https://github.com/substrat-run/substrat/blob/4aea8131151f4294d49145a0381b70aa0dbc5179/spikes/workflows-wfp/RUNBOOK.md) for a test account).
That PR was closed without merging, so the paths named below (`src/vertical.mjs`,
`run-local.mjs`, …) are in that commit, not in this tree.

Run locally on macOS, 24 November 2026: `node run-local.mjs` (miniflare 4.20260730.0, workerd),
12 PASS, 6 FAIL, the same on three runs. The probe was also run against a local stand-in for the
dispatcher, with the same results. **Nothing here ran on a Cloudflare account or a dispatch
namespace.** The Cloudflare documentation was read on the same day. Local workerd runs miniflare's
Workflows engine, not Cloudflare's, so every local answer about the engine's behaviour is evidence,
not proof. [The runbook](https://github.com/substrat-run/substrat/blob/4aea8131151f4294d49145a0381b70aa0dbc5179/spikes/workflows-wfp/RUNBOOK.md) is what a person runs on a test account to answer the rest.

## The verdict under the rule

The rule keeps Workflows as the default only if binding, waking, promote and preview all pass, and
**a question the spike cannot answer counts as a fail**.

| Condition | Answer | Why |
| --- | --- | --- |
| Binding, and the same door | **Unknown** hosted. Yes locally, with a qualification | The binding in a dispatch namespace was not tried (runbook step 3). A step reaches the scope host's door, the one schedules use, not the router's |
| Waking | **Yes locally, under three design rules.** Cross-vertical not run | The event is a bell and the scope holds the fact. The flow reads the scope before its first wait. The ring is journalled |
| Promote with instances in flight | **No as written.** Hosted behaviour unknown | Locally an instance resumes on the promoted code and replays by step name. A renamed or inserted step runs again. Holding an instance on its version needs a binding the sandbox refuses |
| Preview | **No as written.** Hosted naming and deletion unknown | Tied to its copy only when the archive script has its own workflow name. A step's own `fetch` is not held on the copy |
| Cost | **Low**, from published prices. Not measured | A waiting instance uses no CPU and no concurrency slot. It is billed per step and per stored byte |

**So, today, Workflows fails the rule:** three conditions turn on facts only the hosted engine can
give, and two fail locally as the RFC states them. Under the rule, the engine is the step journal in
the scope until the runbook is run. If the runbook comes back clean, Workflows could pass only with
the platform rules listed under *What would make it pass*. Those rules are the same ones a step
journal needs, but the journal can enforce them itself.

## What ran

`src/vertical.mjs` is a toy vertical. `ScopeDO` keeps facts, an outbox and an idempotency record,
and a key's first call records its result in the operation's own transaction. A second call returns
that record, and a different input is refused (the kernel's `idempotencyKey` shape, `scope-host.ts`).
It also has a `PRIMARY` flag, and on a copy it holds an outbound effect (the #2005 gate in one line).
`OrderFlow` is a `WorkflowEntrypoint`. Every step is one scope operation under the key
`<instance>:<step>`, and a wait on a person is `waitForEvent`. `src/entry.mjs` has the platform
entry's shape: `export *` from the vertical, with only the default export's `fetch` wrapped. The
wrapper counts its passes, standing in for the wire gate.

`run-local.mjs` runs `scenarios.mjs` (shared with `probe.mjs`) and three local-only experiments: a
workflow name declared by two scripts, a promote, and an instance held on its version.

## Binding and door

- **Cloudflare documents Workflows as a binding a user Worker in a dispatch namespace may carry**
  ([WfP bindings](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/bindings/):
  "Process work asynchronously with Queues and Workflows"). It was **not tried**. The upload metadata
  type is `workflow`, with `workflow_name` and `class_name`. Workflow names are **unique per
  account**, not per script or namespace.
- **The uploader would refuse it today.** `workflow` is not in `ADMISSIBLE_BINDING_TYPES`
  (`packages/contracts/src/deploy.ts`). Admitting it is a platform change: the allowlist, a per-script
  workflow name, and the re-upload on promote.
- **A step reaches the scope (PASS).** A step called `env.SCOPE` and ran `open-order` as the app.
- **But not through the router's door (PASS on the measured property).** Over the whole flow, the
  gate counted exactly the harness's own calls (`gatePasses 3 = harnessCalls 3`). The engine calls
  `run()` directly, never through `fetch`, and the platform entry re-exports the class unwrapped. A
  step is in-script host code, the same position as the platform's scope sweeper. It can reach the
  scope host's `invoke`, with its guards, input parse, permission check and idempotency, as the
  app. It carries no K-58 envelope and no person. RFC §7.6 already leans "it runs as the app, and a
  step needing a person's right is an approval step a person takes". This confirms that is the
  only option: no actor reaches `run()` except what the instance's params carry, and the params are
  not signed.

**Answer:** "the same door as any other call" holds only if *the door* means the scope host's
invoke, the one schedules use. It does not hold for the router's door. The RFC should say which one
it means. The hosted binding is **unknown**.

## Waking

The case the engine is for: an event committed in a scope wakes the instance waiting for it.

- **Who delivers: the scope**, after its commit and never inside it (K-62). The scope rings the
  instance it derives from the order (`flow-<scope>-<order>`) with `sendEvent`. The approval
  committed, the scope rang once, and the flow closed the order once (PASS ×3).
- **An event sent before the wait is buffered (PASS).** This is documented ("The event will be
  buffered and delivered when the Workflow reaches the waitForEvent step") and seen locally: a bell
  sent while the instance slept woke the wait that followed.
- **An event committed before the instance exists is lost (FAIL).** `sendEvent` throws
  `instance.not_found`, and the ring has nowhere to go. The instance, created later, waited with the
  event in the scope's outbox. One more bell rescued it, because the flow reads the scope after each
  bell. **Rule 1: a flow reads the scope before its first wait**, and creating an instance must be
  ordered after, or be idempotent with, the event that starts it.
- **A repeated delivery is not harmless when the event carries the fact (FAIL).** With two
  deliveries of one event, the flow's next `waitForEvent` of the same type returned the repeat at
  once (`second: {"n":"repeat"}`). The engine buffers per type and does not deduplicate.
- **It is harmless when the event is a bell and the scope holds the fact (PASS).** Two stray bells
  before the approval, and one after, still gave one close. **Rule 2: the event is a payload-less
  bell, and after each bell the flow reads the scope's outbox.** That also avoids a documented
  limit: a `waitForEvent` type takes only letters, digits, `-` and `_`, so `invoicing.underlag-exported`
  cannot be a type as it is.
- **At least once needs a journal, which this spike does not have.** The scope rings with a
  best-effort call after its commit. A ring that fails is counted (`rings-failed`) and not retried.
  For at-least-once, the ring has to be a journalled delivery that the scope retries: the outbox
  consumer path (`_substrat_deliveries`) or the platform request journal, which is the 32-slot one
  that #3365 is about. **Rule 3: the ring is a journalled delivery.** With rules 1 and 2, a retried
  ring is harmless.
- **Cross-vertical was not run.** By [cross-vertical-events.md](../../docs/architecture/cross-vertical-events.md),
  an imported event lands in the consuming scope as a consumer delivery (journalled, at least once,
  one row per event and module). So the deliverer is the same scope, ringing from that delivery, and
  rules 1 to 3 cover it. It was not exercised end to end.
- `sendEvent` to a completed instance returned without error locally. A late bell is silently
  dropped.

**Answer:** yes locally, under rules 1 to 3. The deliverer is the scope (the RFC's first
alternative), never the dispatcher calling the event API. That way the outbox stays the one source
and the ring rides its at-least-once delivery.

## A promote with instances in flight

K-33: a promote re-uploads the promoted bundle onto the stable script in place. Locally, a promote
was the same script name and the same persisted Workflows and Durable Object state, restarted on
other code.

- **A waiting instance resumes on the promoted code (PASS).** It closed with `closedBy: "v2"`, and a
  sleeping instance did the same.
- **Replay is by step name.** On resume the engine runs `run()` from the top on the new code. A step
  whose name it has recorded returns the recorded result, and a step whose name it has not seen
  runs.
  - **A renamed step runs again (FAIL).** v2 renamed `open` to `open-order`. The order was opened
    twice, `["open-order@v1", "approve@v2", "open-order@v2", "close-order@v2"]`. The idempotency
    key `<instance>:<step>` did not save it, because the step's name is the key's second half.
  - **A step inserted before the current position runs (FAIL).** v3 added `note-inserted` before
    the wait the instance was in. It ran on resume: `["open-order@v1", "approve@v3", "note@v3", "close-order@v3"]`.
  - So a completed step's recorded result means "the value a step of this name returned", whatever
    the step does now. Removing a step is safe, and reordering is safe only when names are kept.
- **Holding an instance on its version works locally, at a price (PASS).** A per-version script
  (`acme-v1`, workflow `acme-v1-flow`) whose `SCOPE` binding names the stable script's class
  (`script_name`) kept its instance on v1 across a promote of the stable script, and wrote to the
  production scope: `flowCode: "v1"`, one open. But:
  - the operations it called ran on the **promoted** scope code (`close-order@v2`). Holding the flow
    does not hold the operations, so a held flow is a cross-version caller of its own app's
    operations;
  - the sandbox refuses this binding today. A `durable_object_namespace` is admitted "for the
    vertical's OWN classes (no `script_name`)" (`deploy.ts`), and
    [scope-store-binding](../scope-store-binding/FINDINGS.md) shows why a cross-script binding needs
    care;
  - it is one more script, and one more workflow, per version still in flight.
- **Drain** is the remaining option: `terminate` (documented, and local since March 2026) or wait.
  The platform would have to list a vertical's instances in flight at promote. They are outside
  every scope, so no scope can report them. A step journal in the scope is listed by the scope, and
  can be judged the way K-33 judges the migration digest.
- **Hosted: unknown.** The documentation does not say which code a resumed instance runs after a
  deploy. Workers' versioning pins Durable Objects per deployment, and says nothing on Workflows.
  Runbook step 6 asks it.

**Answer:** no as written. It is predictable only under a rule nobody enforces yet: step names
frozen, steps only appended, an in-flight step never removed before its instance has passed it. The
alternatives are a drain the platform cannot see from the scope, or a held version with a refused
binding whose operations still move. Hosted behaviour: unknown.

## A preview

A preview runs an archive script (`<slug>-<versionId>`) against a copy that must stay inert (#2005).

- **With its own workflow name, the instance is tied to the preview's script and copy (PASS).** An
  instance started through the preview script's binding wrote to the preview's scope only. The
  production binding could not see it (`instance.not_found`).
- **With the stable script's workflow name, it is not (FAIL).** Two scripts declared `acme-flow`. An
  instance created through the preview's binding ran the **production** script's code against
  **production's** data: `copyFacts: []`, `realFacts: ["open-order@v1"]`. Hosted, workflow names are
  unique per account, so the second upload is either refused or re-points the workflow. Which of the
  two is unknown (runbook step 8). Either way, **an archive script uploaded with the stable script's
  bindings as they are is unsafe**. Every script needs its own workflow name, and a preview of a
  version needs one more workflow.
- **An effect requested through a scope operation is held on the copy (PASS).** That is the #2005
  gate doing its job.
- **A step's own `fetch` is not held (FAIL).** The step reached `outside.example` from the copy. The
  scope's gate sees only scope operations. Hosted, the question is whether a dispatch namespace's
  outbound worker (the role `vertical-egress` plays, D-46) sees a fetch from a Workflow step at all,
  since no dispatch invocation is in progress when the engine runs `run()`. Unknown (runbook step 5,
  the `direct-fetch` counter). Until then, **steps must be scope operations only**: no network, as
  module code already must not, enforced on the Workflow class too.
- **Delete and carry are unknown.** Does deleting a script delete its workflow and instances? Does a
  waiting instance of a deleted script fail, linger or resume onto a re-uploaded script of the same
  name? Runbook step 7 asks. Carrying a copy onto a new version (#1710) moves the data to a new
  archive script with a new workflow name, so the old instances stay on the old script. Then the
  platform must terminate or delete them (`deleteBatch`, up to 100 per call), or they wake against
  a wiped copy.

**Answer:** no as written. It is tied only with a workflow name per script, and it is inert only if
steps are confined to scope operations. Deletion and carry are unknown.

## Cost

From the published prices (Workers Paid, checked 24 November 2026; step and storage billing since
August 2026):

- A waiting or sleeping instance uses **no CPU**, and does not count against the 50,000-instance
  concurrency limit.
- **Steps:** 500,000 a month included, then **$0.80 per 100,000**. A sleep and a wait count as steps
  for billing, but not toward the per-instance step limit (10,000 by default, up to 25,000).
- **Storage:** 1 GB-month included, then **$0.20 per GB-month**, sleeping and waiting instances
  included. Completed state is kept 7 days by default.
- **Requests and CPU time** at Workers Standard rates.

An instance that waits four weeks, with about ten steps and 10 KB of state, costs about $0.00008 in
steps and $0.000002 in storage. That is about **$0.80 per 10,000 such flows a month**. Waiting
itself is close to free. The hard limits are about time, not money: `waitForEvent` defaults to a
**24-hour** timeout and allows at most 365 days, and a timeout throws and fails the instance unless
caught. A wait of weeks must set its timeout, and a longer one must loop. Measured figures are
runbook step 9.

## Where this supports or contradicts #3367

[#3367](https://github.com/substrat-run/substrat/issues/3367) proposes event delivery on Queues, with
connector jobs on Workflows. This spike tested no Queue.

- **Supports: enqueue references, not payloads.** This is the same finding as rule 2: the scope
  holds the fact and the message is a pointer. #3367 reaches it from the 128 KB limit and PII. Here
  it comes from repeat safety: a repeated payload is a second fact.
- **Supports: idempotency by (consumer, eventId).** A retried step ran its operation once under a
  key recorded in the operation's own transaction (PASS). That is the same mechanism.
- **Supports: waiting costs nothing**, and a long job holds no request or lease open. The prices
  above agree with #3367's limits table.
- **Qualifies: "finished steps are not repeated"** holds within one version. Across a promote, a
  renamed or inserted step runs again (FAIL ×2). A connector job in flight across a promote can redo
  an external call, unless step names are frozen or jobs are drained first.
- **Qualifies: "`substrat push` creates and binds the vertical's … Workflow class".** Workflow names
  are unique per account, so the stable script and every archive script each need their own name.
  Reusing the stable name on an archive ran preview traffic on production locally. The binding also
  needs `workflow` in `ADMISSIBLE_BINDING_TYPES`.
- **Contradicts, in part: "Preview copies … the enqueue must respect the same gate".** Gating the
  enqueue is not enough. A connector job's own steps call the outside world, and a step's `fetch`
  was not held on a copy. The gate has to be in the step too, or the hosted outbound worker has to
  be shown to see a step's fetch (runbook step 5).
- **Adds: a Workflow step acts as the app.** #3367's "step 1 `ctx.invoke(...started)`" runs in-script
  with no router envelope, so K-66/K-67's caller and actor do not reach it. Whatever the job does
  for a person needs that person's right recorded before the job starts.
- **Adds: dotted event types cannot be `waitForEvent` types.** That holds if #3367's
  `dam.file-received` style ever reaches a `waitForEvent` rather than a Queue message.

## What would make it pass

If the runbook comes back with: the binding admitted in a dispatch namespace; a resumed instance on
the promoted code, as locally; a second script with the same workflow name refused rather than
re-pointed; a step's fetch seen by the outbound worker; and a deleted script's instances gone. Then
Workflows passes **only with these platform rules**:

1. Every script gets its own workflow name: the stable script, and each archive script.
2. Steps are scope operations only, so no network from the Workflow class (a boundary-lint rule
   beside R3).
3. The waking rules: a bell, a read of the scope, the read before the first wait, and the ring
   journalled.
4. Step names are frozen and steps only appended, checked at push against the version in flight, or
   a promote that changes the steps drains first.
5. The platform terminates a preview's instances on delete and on carry.

Rules 3 and 4 apply equally to a step journal in the scope: any engine that replays by step id has
them. The difference is where they can be held. The journal lives in the scope, so the scope can
list its instances in flight, refuse a promote that changes their steps, and carry or wipe them
with the copy. Workflows instances live outside every scope, and each of those needs platform code
that does not exist.

## Run log

```
# binding and door
SEEN  [status-at-wait] the status reported for an instance parked in waitForEvent: "running"
PASS  a step runs a scope operation, as the app, from the Workflow class
SEEN  [door] gate passes vs harness calls while the remaining steps ran: {"gatePasses":3,"harnessCalls":3}
PASS  no step's scope call passed the entry's gate: run() is not reached through fetch
PASS  an approval committed in the scope rings the instance and it completes
PASS  the flow closes the order once
PASS  the scope rang the instance once, after its commit
# waking
PASS  a bell sent before the wait is buffered and wakes the wait
SEEN  [bell-before-instance] scope counters after ringing an instance that does not exist yet: {"rings-failed":1,"ring-error:instance.not_found":0}
SEEN  [lost-bell] an instance created after its event was committed, once parked: {"status":"running","outboxHasIt":true}
FAIL  an event committed before the instance exists still reaches it  "running"
SEEN  [rescue] the same instance after one more bell: "complete"
SEEN  [repeat-payload] a payload flow given the same delivery twice: {"mode":"payload","first":{"n":"first"},"second":{"n":"repeat"}}
FAIL  a repeated delivery is harmless when the event carries the fact
PASS  repeated and stray bells are harmless when the scope holds the fact
SEEN  [bell-unknown] sendEvent to an instance id that was never created: {"error":"instance.not_found"}
SEEN  [bell-complete] sendEvent to a completed instance: {"sent":true}
# a retried step
SEEN  [retry] attempts of the open step, and the open facts it left: {"attempts":2,"opens":1}
PASS  a retried step's operation runs once, under the key (instance, step)
# a preview
PASS  an instance started on the preview's script writes to the preview's copy only
PASS  a step's outbound effect requested through a scope operation is held on the copy
SEEN  [preview-direct-fetch] what a step's own fetch reached, on the copy: {"counters":{"direct-fetch:reached":1},"outsideHits":["outside.example"]}
FAIL  a step's own fetch is held on the copy too
SEEN  [preview-instance-from-prod] the preview's instance id, asked of the production script's workflow: {"error":"instance.not_found"}
# one workflow name on two scripts
SEEN  [name-clash] an instance created through the second of two scripts declaring one workflow name: {"createdThrough":"acme-v2 (the copy)","copyFacts":[],"realFacts":["open-order@v1"]}
FAIL  an instance created through a preview's binding never writes to production
# a promote with instances in flight
SEEN  [promote-waiting] facts of an instance that waited across the promote (v2 renamed its first step): ["open-order@v1","approve@v2","open-order@v2","close-order@v2"]
PASS  a waiting instance resumes on the promoted code
FAIL  a step renamed by the promote is not run a second time
SEEN  [promote-sleeping] an instance stopped in a sleep, after the promote, woken and approved: {"statusAfterItsSleep":"running","output":{"mode":"doorbell","found":{"seq":2,"type":"orders.approved","ref":"z"},"closedBy":"v2"},"facts":["open-order@v1","approve@v2","open-order@v2","close-order@v2"]}
SEEN  [promote-inserted] facts of an instance whose code gained a step before its current wait: ["open-order@v1","approve@v3","note@v3","close-order@v3"]
FAIL  a step inserted before the current position does not run for an instance already past it
# an instance held on its version
SEEN  [pinned] an instance in a per-version workflow script, across a promote of the stable script: {"flowCode":"v1","factsInProduction":["open-order@v1","approve@v2","close-order@v2"]}
PASS  an instance can stay on the version that started it, writing to the production scope
```

One local quirk: miniflare reports an instance parked in `waitForEvent` as `running`, never
`waiting`, so the harness reads "parked" from the scope instead.
