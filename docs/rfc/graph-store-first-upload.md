---
status: proposed
layer: kernel
description: The hosted checks for the graph driver's first release. None of these commands have been run.
---

# First upload of the graph store driver

The pin is in `STORE_DRIVERS` ([graph store registration](./graph-store-registration.md)).
Its sha256 is `1fb0bb0be73c05239b5e769280461c3049ef295f2f92cab90cba9c15ba5ad122`,
595 modules, 4530224 bytes, schema 0, entry `driver_graph/store.py`, source commit
`f49ef6bb16691517a38fd36268ceb79834d6fbc6`. Nothing below has been run. Do not run it
until that pin is on the deployed control plane. A write uses a person's
`substrat login`. The service token is refused. The line `authenticating with` must
name that sign-in. If it names the service token, stop.

Use the test dispatch namespace `substrat-verticals-test` and the test bucket
`substrat-store-releases-test` first. Both names are in
`apps/control-plane/wrangler.jsonc`. Production (`substrat-verticals`,
`substrat-store-releases`) is a later decision, not part of this pass.

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

Rollout has no flag for one vertical. It moves every vertical that declares `graph`.
None does today, so this rollout uploads the canary script
`substrat-store-graph--canary` and moves zero verticals:

```text
substrat store-driver rollout --driver graph --sha256 1fb0bb0be73c05239b5e769280461c3049ef295f2f92cab90cba9c15ba5ad122
```

The answer is `rollout to 1fb0bb0be73c05239b5e769280461c3049ef295f2f92cab90cba9c15ba5ad122: good`
and `0 vertical(s) this run`. The canary, on a fresh object that holds no tenant data,
calls `substrat.size`, `substrat.export` (no rows), `substrat.import` of that export,
`substrat.export` again (the same tables), `substrat.erase` of a subject the object
never held (`erased` 0), `substrat.wipe`, and `substrat.export` once more (still no
rows). A failed canary ends the rollout `failed` and moves nothing.

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

```text
substrat store-driver rollback --driver graph
```

The answer is `409` and `driver 'graph' has no previous good release to roll back to`.
Run `status` again. The current sha256 is unchanged. Any other status, or a current
sha256 that moved, is a failure: collect the problem body and stop.

## 7. One vertical, then a caller-signed call

A caller-signed call is a vertical operation that does
`getScopeStore(principal, tenantId, scopeId, 'GRAPH')` and `invoke`s a catalog
operation, for example `getSession`. The router signs that call. No command does it
from the CLI, and no demo operation calls the store. The canary's calls are
platform-signed. They are not this step.

The smallest declaration is on `ticket0`, in a separate commit on this branch:
`runtimeNeeds.scopeStores: [{ binding: 'GRAPH', driver: 'graph' }]`. It does not add
an operation. Merging it means the next push of that vertical uploads
`substrat-store-graph-ticket0` and then serves every tenant of that vertical from that
one script. Drop the commit unless that is intended. Do not push it as part of reading
this page.

After that push, the answer that the store script exists is a push that finishes, and
`status` still showing the same sha256. Then a scope of that vertical invokes
`getSession` through its own operation. The answer is a result, not a router refusal
and not `bad_envelope`. Collect the status and the error code if it is not a result.
There is no vertical operation to name until one is added.

## What a failure should keep

The command, the exit code, the HTTP status, and the problem body. Not a token, an
account id, or a key. For a `502` from the upload or the canary, also the script name
(`substrat-store-graph--canary` or `substrat-store-graph-<vertical>`) and whether any
vertical was listed as moved.
