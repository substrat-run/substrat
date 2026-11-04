# Runbook: the store facets spike on a real dispatch namespace

This is run by a person who holds a Cloudflare credential, on a **test** account. It is never run
on the production account, and never against the platform's own dispatch namespace or scripts.
Everything it creates has a name starting `substrat-spike-store-facets`. Step 8 removes all of it.

The spike stores nothing but its own probe rows. The graph release is only loaded and asked for
`substrat.selfcheck`, and no tenant's data is involved.

Each step says what to expect and what to paste back. The figures fill the **Measured** table of
[D-70](../../docs/decisions/D-070-a-store-driver-s-code-runs-in-its-own-loaded-isolate-outside-the-verifier-with-no-network.md).
The last section maps them row by row.

## 0. Before you start

- Node 22 and pnpm 10.
- A Cloudflare account on the Workers Paid plan with Workers for Platforms enabled. Dynamic Workers
  (the Worker Loader) need the Paid plan.
- `npx wrangler login`, or `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment.
  The token needs Workers Scripts edit and Workers for Platforms edit on that account.
- The graph driver release directory, as it is uploaded: the `driver_<package>/` directory and its
  `python_modules/`. You also need the module that defines the store class (for example
  `driver_graph.store`) and the class name (`Store` for the release reviewed so far).

All commands run from `spikes/store-facets/`.

## 1. Local run (no account)

```
pnpm install --ignore-workspace
node build-graph.mjs
node run-local.mjs
```

**Expect** 23 `PASS` lines and exit 0. Any `FAIL` here is a problem with the spike: stop and
report it, rather than deploying.

## 2. Pack the graph release

```
node build-graph.mjs --release <path to the release dir> --entry <python.module> --class <ClassName>
node run-local.mjs --graph
```

**Expect** a line `graph-release.bin: <n> files, <bytes> bytes of release, …`, with about 1 318
files and 7.4 MB. Then 25 `PASS` lines, including `[cold-start] graph: measured (first … ms, warm …
ms, heap …)`.

**Paste back** both lines: the build line, and the graph cold-start line from the local run.

## 3. Create the namespace and upload the supervisor

```
npx wrangler dispatch-namespace create substrat-spike-store-facets
node -e "console.log(crypto.randomUUID())"
npx wrangler deploy --dispatch-namespace substrat-spike-store-facets --var SPIKE_TOKEN:<the token printed above>
```

**Expect** the deploy to list `env.SUPERVISOR (Supervisor) Durable Object` and `env.LOADER Worker
Loader`, and to succeed.

**Paste back** the deploy's full output, success or failure.

**If the deploy is refused**, for example over `worker_loaders` in a dispatch namespace, that refusal
answers D-70's first question. Keep it, and run the rest as an ordinary worker instead, so the other
questions still get answers:

```
npx wrangler deploy --name substrat-spike-store-facets-plain --var SPIKE_TOKEN:<token>
```

Skip step 4, and use the `workers.dev` URL this prints as `<url>` in step 5, with
`--label plain-run-1`.

## 4. Upload the dispatcher

```
cd dispatcher
npx wrangler deploy
cd ..
```

**Expect** a `https://substrat-spike-store-facets-dispatcher.<subdomain>.workers.dev` URL. A new
script may take about 15 seconds to answer everywhere (K-28). If step 5's first check reads `404` or
`Worker not found`, wait a minute and run it again.

## 5. Probe it, three times

```
node probe.mjs --url <url> --token <token> --graph --label wfp-run-1
```

Run it again about five minutes later with `--label wfp-run-2`, and once more with
`--label wfp-run-3`. Each run uses fresh objects, so each run measures a cold start.

**Expect** `PASS` on every line, then a block between `==== PASTE BACK FROM HERE ====` and
`==== PASTE BACK TO HERE ====`.

**Paste back** all three blocks whole. A `FAIL` is a finding, not a reason to stop. Keep going.

## 6. Memory beyond the heap figure

Each cold-start line carries the Python heap of the isolate the driver ran in, a lower bound on its
memory. Then:

- In the dashboard, open Workers for Platforms → `substrat-spike-store-facets` →
  `substrat-spike-store-facets`, or the `-plain` worker, → Metrics/Logs.
- Look for any `exceededMemory` or `exceededCpu` outcome over the runs.

**Paste back** whether any appeared, and the error rate shown for the three runs.

## 7. Cost

Wait for the day's usage to show (it can take some hours). Then, in the dashboard, open Billing →
Usage, or Workers & Pages → Plans/Usage → Dynamic Workers.

**Paste back** the number of Dynamic Workers created that day and the amount shown.

To compare: each probe run creates about 20 distinct loader ids. Each block lists them as `"id"`.

## 8. Remove everything

```
npx wrangler delete --name substrat-spike-store-facets-dispatcher
curl -X DELETE -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/dispatch/namespaces/substrat-spike-store-facets/scripts/substrat-spike-store-facets?force=true"
npx wrangler dispatch-namespace delete substrat-spike-store-facets
```

`wrangler delete` has no dispatch-namespace option, so the script in the namespace is removed through
the API (`force=true` because it holds a Durable Object class). Then `dispatch-namespace list` should no
longer name it.

If step 3 fell back to an ordinary worker, also run:

```
npx wrangler delete --name substrat-spike-store-facets-plain
```

Then `rm src/graph-release.bin`. The graph release must not be committed.

## What each answer fills in D-70

| D-70 Measured row | Where it comes from |
| --- | --- |
| A dispatch-namespace script may bind a Worker Loader | Step 3's deploy, plus `[loader]` in step 5 |
| Two loader ids give two isolates; one id reuses its isolate | `[isolate]` lines, js and py, in step 5 |
| `fetch()` and `connect()` throw in a loaded isolate, JavaScript and Python | `[network]` lines in step 5. The control line shows the probe would see an open network. |
| A facet's storage is its own, and survives an abort and a restart under new code | `[storage]` and `[restart]` lines in step 5 |
| A loaded isolate's env holds nothing the supervisor did not pass | `[env]` lines in step 5 |
| Cold start and memory of the graph release in a loaded isolate | `[cold-start] graph` in steps 2 and 5 (first, warm, heap), plus step 6 |
| Cost per loaded isolate per day, as billed | Step 7 |

The choice between an isolate per object and one per (release, tenant, vertical) is made on the
graph cold-start and memory figures. The decision record states which figures it was made on.
