# Runbook: the Workflows spike on a real dispatch namespace

A person who holds a Cloudflare credential runs this on a **test** account. It is never run on the
production account, and never against the platform's own dispatch namespace, scripts or workflows.
Everything it creates has a name starting `substrat-spike-wf`. Step 10 removes all of it.

The spike stores only its own probe rows: toy orders under scope names it makes up. No tenant's data
is involved.

Each step says what to run, what to expect, and what to paste back. The last section maps each
answer to the condition it settles in [FINDINGS.md](FINDINGS.md).

## 0. Before you start

- Node 22 or later, and pnpm 10.
- A test account on Workers Paid with Workers for Platforms enabled.
- `npx wrangler login`, or `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set. The token needs
  Workers Scripts edit, Workers for Platforms edit, and Workflows edit on that account.
- Wrangler 4.152 or later (`npx wrangler --version`).

All commands run from `spikes/workflows-wfp/`. `$NS` below is `substrat-spike-wf`.

## 1. Local run (no account)

```
pnpm install --ignore-workspace
node run-local.mjs
```

**Expect** 12 `PASS` and 6 `FAIL` lines, exit 1. The six FAILs are the local findings. Any other
count, or a `harness error`, means the spike itself is broken: stop and report it before deploying.

## 2. The namespace and its outbound worker

```
npx wrangler dispatch-namespace create substrat-spike-wf
(cd outbound && npx wrangler deploy)
```

**Expect** both to succeed.

## 3. The stable script, with a Workflow, in the namespace: **binding**

```
npx wrangler deploy --dispatch-namespace substrat-spike-wf
npx wrangler workflows list
npx wrangler workflows describe substrat-spike-wf-acme-flow
```

**Expect** the deploy to list `env.FLOW (OrderFlow) Workflow` and `env.SCOPE
(ScopeDO) Durable Object`, and `workflows list` to name `substrat-spike-wf-acme-flow`.

**Paste back** all three outputs, success or failure. **A refused deploy answers the binding
question: Workflows fails the rule.** Keep the refusal text whole, and skip to step 10.

## 4. The dispatcher, then the shared questions: **binding, door, waking**

```
node -e "console.log(crypto.randomUUID())"        # the token
cd dispatcher
npx wrangler deploy
npx wrangler secret put SPIKE_TOKEN                # paste the token
cd ..
node probe.mjs --url <dispatcher url> --token <token> --tag run1 --phase shared
```

The dispatcher URL is `https://substrat-spike-wf-dispatcher.<subdomain>.workers.dev`. A new script
can take about 15 seconds to answer everywhere. If the first call reads `Worker not found`, wait a
minute and run it again with a new `--tag`.

**Expect** the same lines as the local run's `binding and door`, `waking` and `a retried step`
sections. **Paste back** the block between `==== PASTE BACK FROM HERE ====` and
`==== PASTE BACK TO HERE ====`. A FAIL is a finding: keep going.

Note `[status-at-wait]`. Locally it reads `running`, and hosted it should read `waiting`.

## 5. A preview script: **preview, tied and inert**

```
npx wrangler deploy -c wrangler.preview.jsonc --dispatch-namespace substrat-spike-wf
node probe.mjs --url <url> --token <token> --tag run1 --phase preview
```

**Expect** the preview's instance to write to its copy only, and its effect to be held.

**Paste back** the block. The line that matters most is `[preview-direct-fetch]`:

- `direct-fetch:outbound`: the namespace's outbound worker saw a Workflow step's `fetch`. Egress
  control (D-46) covers steps.
- `direct-fetch:reached`: the step's `fetch` went straight out. **Steps bypass the outbound
  worker**, so a step on a copy can reach the world.
- `direct-fetch:refused`: the fetch threw. Paste back the counters as they are.

## 6. A promote with instances in flight: **promote**

A production promote re-uploads the stable script in place (K-33). Here that is `wrangler deploy`
of the same script name with other code. Do steps 6a to 6c in one sitting. The sleeping instance's
ten minutes start at 6a.

```
# 6a. three instances in flight on v1: one waiting, one asleep for ten minutes, one for the insert
node probe.mjs --url <url> --token <token> --tag run1 --phase promote-start

# 6b. promote to v2, which renames the first step; then ask (this can take up to 11 minutes)
npx wrangler deploy --dispatch-namespace substrat-spike-wf --var CODE_VERSION:v2 --var STEP_PLAN:renamed
node probe.mjs --url <url> --token <token> --tag run1 --phase promote-after

# 6c. promote to v3, which inserts a step before the third instance's current wait; then ask
npx wrangler deploy --dispatch-namespace substrat-spike-wf --var CODE_VERSION:v3 --var STEP_PLAN:inserted
node probe.mjs --url <url> --token <token> --tag run1 --phase inserted-after
```

**Paste back** the three blocks. They answer, for Cloudflare's engine:

- `[promote-waiting]` and `a waiting instance resumes on the promoted code`: which code a resumed
  instance runs. **The documentation does not say. This is the spike's most important hosted answer.**
- `a step renamed by the promote is not run a second time` and `[promote-inserted]`: whether the
  hosted engine also replays by step name.
- `[promote-sleeping]`: whether an instance asleep at the promote wakes on time, and on which code.

Then put the stable script back on v1 for the remaining steps:

```
npx wrangler deploy --dispatch-namespace substrat-spike-wf
```

## 7. Deleting a preview's script: **preview, delete**

```
curl -X DELETE -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/dispatch/namespaces/substrat-spike-wf/scripts/substrat-spike-wf-acme-v2?force=true"
npx wrangler workflows list
npx wrangler workflows instances list substrat-spike-wf-acme-v2-flow
npx wrangler workflows instances describe substrat-spike-wf-acme-v2-flow flow-s-run1-pv-run1-pv
```

Then send that instance an event (see `npx wrangler workflows instances send-event --help` for the
flags; the type is `doorbell`). Then re-deploy the preview script under the same name, and describe
the instance again after a minute:

```
npx wrangler deploy -c wrangler.preview.jsonc --dispatch-namespace substrat-spike-wf
npx wrangler workflows instances describe substrat-spike-wf-acme-v2-flow flow-s-run1-pv-run1-pv
```

**Paste back** every output. They answer whether a deleted script's workflow and waiting instances
survive it, what an event to them does, and whether they resume onto a new script of the same name.
A carry (#1710) moves a copy to a **new** archive script with a new workflow name, so if they survive,
the platform has to terminate them itself.

## 8. One workflow name on two scripts: **preview, naming**

This is deliberately last before the cost step: it may re-point the stable script's workflow.

```
npx wrangler deploy -c wrangler.clash.jsonc --dispatch-namespace substrat-spike-wf
npx wrangler workflows describe substrat-spike-wf-acme-flow
node probe.mjs --url <url> --token <token> --tag run1 --phase clash
```

**Paste back** the deploy output whole, then the describe output and the block.

- **The deploy is refused** (the name belongs to another script): an archive script uploaded with
  the stable script's bindings fails loudly. Good.
- **The deploy succeeds**: `describe` shows which script now owns the workflow, and the probe's
  `[clash-via-stable]` shows whether instances created through the stable script now run the clash
  script's code. If they do, **an archive upload can silently take over production's flows.**

## 9. Cost

The day after, in the dashboard: Workers & Pages → Workflows → `substrat-spike-wf-acme-flow` →
Metrics. Note the steps, the instances, and the stored bytes for the days of the run. The same
figures, including `stepCount` per instance, are in the GraphQL Analytics API's Workflows datasets
([metrics and analytics](https://developers.cloudflare.com/workflows/observability/metrics-analytics/)).
Then Billing → Usage, for the Workflows lines.

**Paste back** the step count, the stored-bytes peak and any billed amount. The findings' estimate
of about $0.80 per 10,000 four-week flows a month is to be checked against these.

## 10. Remove everything

```
for s in substrat-spike-wf-acme substrat-spike-wf-acme-v2 substrat-spike-wf-acme-clash; do
  curl -X DELETE -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/dispatch/namespaces/substrat-spike-wf/scripts/$s?force=true"
done
npx wrangler delete --name substrat-spike-wf-dispatcher
npx wrangler delete --name substrat-spike-wf-outbound
npx wrangler dispatch-namespace delete substrat-spike-wf
npx wrangler workflows list
```

If `workflows list` still names a `substrat-spike-wf-*` workflow, step 7 has already told you that
deleting a script leaves its workflow. Delete it in the dashboard (Workflows → the workflow →
Settings → Delete), which also deletes its instances. Paste back whether you had to. Then
`rm .probe-state-*.json`.

## What each answer settles

| Condition (RFC §8, the Workflows spike) | Step | Passes when |
| --- | --- | --- |
| The uploader binds a Workflow class to a script in the dispatch namespace | 3 | The deploy lists the workflow binding and `workflows list` names it |
| An instance runs scope operations through the same door as any other call | 4 | `a step runs a scope operation…` PASS. The door is the scope host's, see FINDINGS.md |
| An event committed in a scope reaches the waiting instance, at least once, repeat-safe, not lost before the wait | 4 | The `waking` lines, as locally. The two local FAILs are design rules 1 and 2, not engine faults |
| An instance in flight behaves predictably across a production promote | 6 | Resumes on promoted code with replay by name, as locally (then design rule 4), or stays on its version |
| An instance on a preview stays tied to the archive script and its copy, and is inert there | 5, 7, 8 | Tied with its own name (5). A same-name upload is refused (8). A step's fetch is seen by the outbound worker (5). A deleted script's instances are gone or can be terminated (7) |
| Cost of an instance that waits for weeks | 9 | Measured figures match the published prices |
