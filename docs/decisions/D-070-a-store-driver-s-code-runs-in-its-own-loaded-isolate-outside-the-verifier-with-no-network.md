---
id: D-70
date: 2026-11-04
layer: plan
title: "A store driver's code runs in its own loaded isolate, outside the verifier, with no network"
status: proposed
aliases: []
amends: ["D-63", "D-67"]
tracking: ["#2830"]
---

# D-70 — A store driver's code runs in its own loaded isolate, outside the verifier, with no network

> **Proposed 2026-11-04, not ratified.** The route is chosen. The spike in `spikes/store-facets/`
> has run on a real dispatch namespace, and its figures are in **Measured** below. Three are still
> missing: whether the loader id is what keeps two objects apart, the isolate's memory beyond the
> Python heap, and the billed cost. They come from another run that reads the dashboard before the
> account is cleaned. If a figure rules the route out, this record says so and is withdrawn rather
> than ratified. Nothing is built on it until then.

**The store script runs only platform code, and the driver's code runs beside it in an isolate of its own.** The store script keeps D-63's shape, one script per (driver, vertical), uploaded and rolled out as today. What changes is what runs in it:

- **The platform's object is the only class the script executes.** `SubstratStoreObject` becomes a supervisor written in JavaScript by the platform, for JavaScript and Python drivers alike. It verifies the envelope, checks that its own id is the id of the signed name, and spends the envelope's nonce (K-59), all in its own storage, before anything of the driver's runs.
- **The driver's modules travel inert.** The upload carries them as Text and Data modules. The script never imports them. The supervisor hands them to the runtime's Worker Loader, which builds a separate isolate from them.
- **One loaded isolate per object.** The loader's id is the release's sha256 and the object's name. Driver code for one object never runs in the isolate of another, so it never shares one with another tenant's object either. A new release has a new id, so the next call after a rollout loads the new code.
- **The loaded isolate has no network and no bindings.** It is loaded with `globalOutbound: null`, under which `fetch()` and `connect()` throw, and with an empty env. It gets no store namespace, no verification keys and no platform binding. A CPU limit per call bounds it as well.
- **The driver's class runs as a facet of the supervisor's object, with storage of its own.** The facet has its own SQLite database. The supervisor cannot read it, and it cannot read the supervisor's, where the nonces live. The driver keeps `ctx.storage.sql` as it has it today, so a driver changes nothing to run this way. A rollout aborts the facet and starts it again under the new code. Its storage is kept.

The canary, the rollout across verticals, the rollback to the previous good release and the fleet rebuild (D-63, D-65) keep their shape. They move a release to a script exactly as before, and the supervisor loads what the script names.

**The fallback is one isolate per (release, tenant, vertical)**, chosen only if the measured cold start or memory of an isolate per object is unaffordable for the graph driver, with the figures that show it written below. Under it, separation between one tenant's objects is held by review, as K-53 already accepts inside a tenant. Separation between tenants stays by construction.

## What this meets, and what it does not

| D-63 condition | Met by |
| --- | --- |
| A driver's code never runs where another tenant's objects are | The loaded isolate is per object (per tenant under the fallback). The script per tenant D-63 names is a means to this, and an isolate per object reaches it more narrowly. |
| No outbound access | `globalOutbound: null` on the loaded isolate. |
| Verification of the envelope outside the driver's reach | The supervisor verifies in the script's own isolate, which runs no driver code. |

It does not stop a driver from writing wrong data into its own object or answering wrongly, which is what the review of a release (D-65) and the canary still look for. It does not make the driver's erasure real: `erasure: 'pending'` stays until the driver erases (D-67). It makes the platform depend on the runtime's Worker Loader and facets doing what they say, which the spike checks and a test in this repo keeps checking.

When this is built, D-67's lift is withdrawn under its own revisit clause, and the graph driver's registration names this record as a basis that holds by construction rather than a lift.

## Measured

From three runs of the spike (`spikes/store-facets/RUNBOOK.md`) on 2026-11-04, about five minutes apart, on a test account with Workers for Platforms, at spike commit `69e274990`, with graph release `678ab0f4…` (1 324 files, 7.6 MB). Each run passed 22 of 24 checks, and the same two failed each time. The runs are in [FINDINGS.md](../../spikes/store-facets/FINDINGS.md#deployed). Each figure is required, and an unmeasured one blocks ratification: the memory beyond the heap and the billed cost are still unmeasured, and need another run that reads the dashboard before the account is cleaned.

| Question | Result |
| --- | --- |
| A dispatch-namespace script may bind a Worker Loader | **Yes.** The deploy lists `env.LOADER` and succeeds. |
| Two loader ids give two isolates; one id reuses its isolate | **Not shown.** One object's calls reach one isolate, and two objects with their own ids reach two. But two objects sharing one id also reached two isolates, in all three runs, so the runs do not show that the id is what keeps them apart, nor that the fallback's sharing is there to save. |
| `fetch()` and `connect()` throw in a loaded isolate, JavaScript and Python | **Yes.** The control with the network inherited reaches it. |
| A facet's storage is its own, and survives an abort and a restart under new code | **Yes,** JavaScript and Python. |
| A loaded isolate's env holds nothing the supervisor did not pass | **Yes,** JavaScript and Python. |
| Cold start and memory of the graph release in a loaded isolate (first call, warm call) | First call **2.1–2.4 s** (2 297, 2 147 and 2 415 ms), warm call **6–8 ms**. Memory: Python heap **43.6 MB** (43 581 440 bytes), a lower bound. **Isolate memory not measured.** |
| Cost per loaded isolate per day, as billed | **Not measured.** The runs used 60 loader ids; at the listed $0.002 per Dynamic Worker per day that is at most about $0.12, which is arithmetic, not a bill. |

## Why

D-63 names three conditions together, and the graph driver meets none of them by construction (D-67). The issue that owns the work (#2830) offered two routes, and neither is enough alone:

- **Verification in a separate script** puts the check out of the driver's reach. But objects of one class in one script may share an isolate and its memory, so the driver's code would still be in reach of another tenant's object without any envelope (store-instances RFC §3).
- **A script per tenant** separates tenants. But it leaves the network open and the verifier in the driver's isolate, so it meets one of the three conditions. It also costs a 7.4 MB, 1 318-file upload per tenant per release, multiplies every rollout, rollback and rebuild by the number of tenants, and opens a first-deploy window on every tenant's first store.

A loaded isolate per object meets all three conditions and keeps one upload per (driver, vertical). It is also the cheapest moment to change where a driver's data lives: the graph driver serves no vertical and holds no tenant's data yet (D-67), so the facet's storage starts empty and nothing has to be moved.
