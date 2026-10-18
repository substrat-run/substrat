---
status: proposed
layer: kernel
description: The hosted checks for the graph driver's first release. None of these commands have been run.
---

# First upload of the graph store driver

The pin is in `STORE_DRIVERS` (`packages/contracts/src/deploy.ts`; see the
[graph store registration](./graph-store-registration.md)). Its sha256 is
`1fb0bb0be73c05239b5e769280461c3049ef295f2f92cab90cba9c15ba5ad122`, schema 0, source
commit `f49ef6bb16691517a38fd36268ceb79834d6fbc6`, entry `driver_graph/store.py`, as that
entry read when this page was written; the bundle is 595 modules and 4530224 bytes by the
author's build.

**Verify these values against `STORE_DRIVERS` before running anything.** This page copies
the sha256 and the commit into four commands and their expected outputs, and nothing
updates them if the pin changes during review. Read the `releases` entry of the `graph`
driver, and use its values wherever this page shows them. The module count and byte size
are not in `STORE_DRIVERS`; a bundle that differs in either is different bytes, which the
sha256 comparison in step 3 catches. Nothing below has been run. Do not run it
until that pin is on the deployed control plane. A write uses a person's
`substrat login`. The service token is refused. The line `authenticating with` must
name that sign-in. If it names the service token, stop.

Use the test dispatch namespace `substrat-verticals-test` and the test bucket
`substrat-store-releases-test` first. Both names are in
`apps/control-plane/wrangler.jsonc`, and only in its `env.test` block: the top level
names the production pair (`substrat-verticals`, `substrat-store-releases`), which is a
later decision, not part of this pass.

The `wrangler` commands below (steps 1 and 2, and the `get` in step 4) are account-level
listings, not worker deploys: they do not take the `env.test` block as a selector, and the
committed file names no `account_id`. Treat them as acting on whatever account wrangler is
signed in to, or on `CLOUDFLARE_ACCOUNT_ID` when that is set. An `absent` or a `10121` from the wrong account
says nothing about the test control plane, and must not block the rollout. Before step 1,
run `npx wrangler whoami` and confirm that the account it names is the one the test control
plane deploys to, which is the one the `CLOUDFLARE_ACCOUNT_ID` repository variable of the
`deploy-test` job in `ci.yml` points at. A person with access to that variable can say
which account it is. Compare by account name. The `whoami` table prints ids: do not paste
its output. If the accounts differ, set `CLOUDFLARE_ACCOUNT_ID` in your shell to the right
one for these commands.

Record the command, the exit code and the response body. Do not record a token, an
account id, or a key.

## 1. Workers for Platforms

From `apps/control-plane`:

```text
npx wrangler dispatch-namespace list
```

The list contains `substrat-verticals-test`. It does not fail with code `10121`.
`10121` means the account does not have Workers for Platforms, and every later step
will fail the same way. Collect the error code and the message.

## 2. The release buckets

From `apps/control-plane`:

```text
npx wrangler r2 bucket list
```

The list contains `substrat-store-releases-test`. `substrat-store-releases` is the
production bucket; record whether it is there, and do not create either bucket from
this pass. The test control plane binds `STORE_RELEASES` to
`substrat-store-releases-test`. A missing test bucket fails the upload at the control
plane before any script is put. Collect which name is absent and the wrangler error.

## 3. Upload the pinned bytes

`substrat store-driver upload` stores the bytes. It does not put a script in front of
a tenant. Pack the same directory the pin was built from (one `driver_graph/` package
and its `python_modules/`). First check out the pin's source commit with a clean tree:
the directory must be at that commit, with nothing untracked, ignored or edited in it.

`--commit` only sets the label the release is stored and pinned under. It does not
check the tree. Without `--commit` the command reads the checkout's own `HEAD` and
refuses a dirty tree or an untracked file (`sourceCommitOf` in `packages/cli/src/store-driver.ts`).
With `--commit <sha>` that check is skipped, so a dirty or wrong checkout is packed and
labelled with the commit you named. The only guard left is the sha256 comparison below:

```text
substrat store-driver upload --driver graph --dir <packed-release-dir> --entry driver_graph/store.py --commit f49ef6bb16691517a38fd36268ceb79834d6fbc6
```

The answer is `✓ stored graph 1fb0bb0be73c05239b5e769280461c3049ef295f2f92cab90cba9c15ba5ad122 (commit f49ef6bb…)`
followed by the line `pinned: roll it out with …`. The line `not pinned yet: …` means the
control plane does not hold this sha256 and commit as a pin: stop. Any other sha256 means these are not the pinned bytes: stop, and do not
roll them out. This upload is also the check that a Python bundle of this size, with
`python_modules/`, is accepted. The script the canary later puts carries
`compatibility_flags: ["python_workers"]`.

On failure, record the HTTP status and the problem body. `422` is the module rule or a
pin mismatch. `413` is the size cap. `502` is the dispatch namespace refusing the
script, which is the Python-in-Workers-for-Platforms question failing. A `502` before
the canary has not moved a vertical.

## 4. Canary, on no tenant

Rollout has no flag for one vertical. It moves every vertical that declares `graph`:
the pending list is every vertical the control plane has a declaration of the driver for,
which is every vertical that has pushed a version declaring it
(`storeDriverRolloutPendingIn` in `packages/kernel/src/store-driver-releases.ts`).

**Precondition: no vertical declares `graph`.** Check both halves before running it:

- In this checkout, no `package.json` carries `"driver": "graph"` under
  `runtimeNeeds.scopeStores`. The ticket0 commit on this branch adds one, so on this
  branch the check fails until that commit is dropped.
- On the test control plane, no vertical has pushed a version that declares it. The
  CLI has no command that lists declarations, so this half cannot be read from here; ask
  whoever operates that control plane.

If either half fails, stop. The rollout then moves those verticals to the pinned release,
so it is no longer a canary on no tenant, and the output below does not apply.

With the precondition true, the rollout uploads the canary script
`substrat-store-graph--canary` and moves zero verticals:

```text
substrat store-driver rollout --driver graph --sha256 1fb0bb0be73c05239b5e769280461c3049ef295f2f92cab90cba9c15ba5ad122
```

The expected answer is `✓ graph rollout to 1fb0bb0be73c05239b5e769280461c3049ef295f2f92cab90cba9c15ba5ad122: good (0 vertical(s) this run)`,
with no `verticals remain` line. That text is **inferred, not observed**: it is the format
string in `cmdStoreDriver` (`packages/cli/src/cli.ts`) applied to what
`runStoreDriverRollout` returns for an empty pending list (`moved: []`,
`complete: true`, state `good`), and no test drives a rollout over an empty fleet. What a
test does pin is the canary's sequence, in
`packages/control-plane-api/test/store-releases.test.ts` ("calls all five, in order"). The
canary, on a fresh object that holds no tenant data, calls `substrat.size`,
`substrat.export` (no rows), `substrat.import` of that export, `substrat.export` again (the
same tables), `substrat.erase` of a subject the object never held (`erased` 0),
`substrat.wipe`, and `substrat.export` once more (still no rows). A failed canary ends the
rollout `failed` and moves nothing.

That is one script for the platform, shared by no tenant yet. The code uploads one
script per (driver, vertical), `substrat-store-graph-<vertical>`, and every tenant of
that vertical shares it. D-63's isolation sentence asks for a script per tenant. A
successful canary does not meet that sentence. Record the script name and that zero
verticals moved.

```text
npx wrangler dispatch-namespace get substrat-verticals-test
```

Record whether that response lists scripts. If it does not, say so; do not invent a
second command. The rollout line is the count that matters.

## 5. Status

```text
substrat store-driver status --driver graph
```

The answer names the current release
`1fb0bb0be73c05239b5e769280461c3049ef295f2f92cab90cba9c15ba5ad122` and the rollout
above as `good`. `rolls back to nothing` is the expected first state: there is no
previous good release.

## 6. Rollback of a first release

Run `status` first. Only run `rollback` if its first line reads `rolls back to nothing`:

```text
substrat store-driver status --driver graph
```

If it names a sha256 after `rolls back to`, there is a release to return to, or a
rollback or paused rollout still under way (the server's `rollbackTarget`, in
`storeDriverStateIn`). A `rollback` would then move a live driver. Skip this step, and
record what `status` printed and that the step was skipped. Do not run `rollback` against
a control plane that already holds a `good` rollout from an earlier run.

With `rolls back to nothing`:

```text
substrat store-driver rollback --driver graph
```

The answer is `409` and `driver 'graph' has no previous good release to roll back to`.
Run `status` again. The current sha256 is unchanged. Any other status, or a current
sha256 that moved, is a failure: collect the problem body and stop.

## 7. One vertical, then a caller-signed call: BLOCKED

This step cannot be carried out today. Do not mark the pass complete without it.

A caller-signed call is a vertical operation that does
`getScopeStore(principal, tenantId, scopeId, 'GRAPH')` and `invoke`s a catalog
operation, for example `getSession`. The router signs that call. No command does it
from the CLI, and no operation of any vertical in this repo calls the store: nothing under
`demos/`, `engines/` or `connectors/` mentions `getScopeStore`, which only the kernel, the
adapters and their tests call. The canary's
calls are platform-signed. They are not this step. A push that finishes proves the script
was uploaded; it says nothing about a caller-signed call, so a finished push is not a pass.

What would make it passable: a vertical operation that takes the store handle for a
declared `GRAPH` binding and invokes one catalog operation on it, in a vertical whose
`runtimeNeeds.scopeStores` declares `{ binding: 'GRAPH', driver: 'graph' }`. That
operation does not exist and this page does not add one. Whether to write it, in which
vertical, and under which permission is for the reviewer to decide.

The smallest declaration is on `ticket0`, in a separate commit on this branch:
`runtimeNeeds.scopeStores: [{ binding: 'GRAPH', driver: 'graph' }]`. It does not add
an operation. Merging it means the next push of that vertical uploads
`substrat-store-graph-ticket0` and then serves every tenant of that vertical from that
one script. Drop the commit unless that is intended. Do not push it as part of reading
this page.

Once an operation exists, the pass criterion is: a scope of that vertical invokes it,
and the answer is a result, not a router refusal and not `bad_envelope`. Collect the
status and the error code if it is not a result.

## What a failure should keep

The command, the exit code, the HTTP status, and the problem body. Not a token, an
account id, or a key. For a `502` from the upload or the canary, also the script name
(`substrat-store-graph--canary` or `substrat-store-graph-<vertical>`) and whether any
vertical was listed as moved.
