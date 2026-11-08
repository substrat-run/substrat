# Findings

## Local workerd (2026-11-04)

`node run-local.mjs` ran on workerd 1.20260730.1 through Miniflare 4.20260730.0, on macOS arm64.
All 23 checks passed.

- **Loader binding.** A script with a SQLite-backed Durable Object and a `worker_loaders` binding
  starts. The binding is present.
- **Isolates.** JavaScript and Python behave the same:
  - two calls to one object, under one loader id, reach the same isolate;
  - two objects with ids of their own reach two isolates;
  - the control, two objects sharing one id, reach one.

  The loader id decides the isolate here.
- **Network.** With `globalOutbound: null`, `fetch()` and `connect()` throw in both runtimes. The
  error is "This worker is not permitted to access the internet via global functions like fetch().
  It must use capabilities (such as bindings in 'env') to talk to the outside world." The control,
  with the network inherited, reached `example.com`.
- **Env.**
  - The driver's env is empty in both runtimes.
  - A JavaScript facet *has* a `ctx.exports`, unlike the store entry's driver under
    `disable_ctx_exports` today. It names only the loaded worker's own export (`ProbeDriver`) and
    nothing of the supervisor's.
  - D-70's build should still decide whether to pass `disable_ctx_exports` in the loaded code's
    flags.
- **Storage.**
  - The facet sees its own table and not the supervisor's. The supervisor sees its own and not the
    facet's.
  - After `ctx.facets.abort`, the next call under a new loader id (new code, `v2`) runs over the
    same facet storage, with its row kept.
- **Cold start (Python probe, not the graph release).** About 1.0–1.1 s for the first call to a fresh
  object, which loads its isolate, and about 1 ms warm. The Python heap of that isolate was 24 MiB
  (25 165 824 bytes).

## What this does not show

The answers that decide D-70 come from [RUNBOOK.md](RUNBOOK.md) on a real dispatch namespace. This
run cannot show any of them:

- whether a dispatch-namespace script may bind a Worker Loader;
- how isolates are placed on the edge rather than on one local process;
- the graph release's cold start and memory;
- what is billed.

The first JavaScript call does not mark a cold start in the same way, because a JavaScript isolate
starts in milliseconds.

## Deployed

Three runs on 2026-11-04, about five minutes apart, on a test account with Workers for Platforms,
at spike commit `69e274990`. The graph release was `678ab0f4…`, 1 324 files and 7.6 MB. Each run
passed 22 of 24 checks, and the same two failed each time. D-70's **Measured** table is filled from
these.

| Question | Result |
| --- | --- |
| A dispatch-namespace script may bind a Worker Loader | Yes. The deploy lists `env.LOADER` and succeeds |
| Two loader ids give two isolates; one id reuses its isolate | Not shown, see below. One object's calls do reach one isolate |
| `fetch()` and `connect()` throw in a loaded isolate, JavaScript and Python | Yes. The control with the network inherited reaches it |
| A facet's storage is its own, and survives an abort and a restart under new code | Yes, JavaScript and Python |
| A loaded isolate's env holds nothing the supervisor did not pass | Yes, JavaScript and Python |
| Cold start of the graph release, first call | 2.1–2.4 s (2 297, 2 147 and 2 415 ms) |
| Warm call | 6–8 ms |
| Memory of the graph release | Python heap 43.6 MB (43 581 440 bytes), a lower bound. No other value |
| Cost per loaded isolate per day, as billed | No value |

**Steps 6 and 7 were not read.** The namespace and scripts were removed before anyone read the
dashboard, so there is no `exceededMemory`, `exceededCpu` or error rate, and no billed figure.
Those rows stay unmeasured until the runbook is run again and read before step 8. The runs used 20
loader ids each, 60 in all. At the listed $0.002 per Dynamic Worker per day that is at most about
$0.12, which is arithmetic and not a bill.

**The two failures are the control `[isolate] js/py: two objects sharing one id reach one
isolate`.** Locally, two objects under one id reach one isolate. Deployed, they reached two, in all
three runs. So:

- The check that two objects with their own ids reach two isolates passes, but it does not show
  that the id is what keeps them apart, since they came apart with a shared id as well.
- The fallback, one isolate per (release, tenant, vertical), assumes that objects sharing an id
  share an isolate. These runs do not show that they will, so its saving may not be there.

**One local-only difference.** With `node run-local.mjs --graph`, the second `substrat.selfcheck`
on an object fails in workerd with `sqlite.c++: expected maybeDb != nullptr; previous reset()
failed`. The graph driver's selfcheck calls `deleteAll` on an object with no repository, which
points at `deleteAll` in a facet; that is not isolated yet. Deployed, the second call answered 200
in all three runs. So step 2's "25 PASS" reads 24 locally on this release.

After the runs, the namespace and the dispatcher both answered 404.

### Rerun (2026-11-08)

Three more runs, about five minutes apart, on the same kind of account, with the same graph
release. The probe gained a control that loads the driver under ids x, x and y inside one object
(`/ids`), so that only the id differs. Each run passed 27 of 29 checks.

| Question | Result |
| --- | --- |
| In one object, one id reaches one isolate | Yes, JavaScript and Python, all three runs |
| In one object, two ids reach two isolates | Yes, JavaScript and Python, all three runs |
| Two objects sharing one id reach one isolate (the control) | No, again, in all three runs: the same two failures as on 2026-11-04 |
| Cold start of the graph release, first call | 2 915, 3 125 and 2 181 ms |
| Warm call | 3–6 ms |
| Memory of the graph release | Python heap 43.6 MB in every run |
| `exceededMemory` / `exceededCpu` | None. Workers analytics for the account over the runs show only `success` and `clientDisconnected` outcomes, and 0 errors |
| Cost, as billed | Read from the day's usage once it shows |

So the id is what separates two loaded isolates: inside one object nothing else differed. Two
objects sharing an id still came apart, most likely because they ran on different machines, so the
fallback, one isolate per (release, tenant, vertical), cannot count on sharing to save anything.

Workers analytics show these scripts as `__unknown__` under Workers for Platforms, so the outcome
counts are for the whole test account, which ran nothing else.
