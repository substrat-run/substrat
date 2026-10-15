# Assistant thread spike (P0)

Evidence for [the assistant RFC](../../docs/rfc/assistant.md) §5.3 and §16 Q2, tracked in
[#2283](https://github.com/substrat-run/substrat/issues/2283). Not a workspace member: nothing
here is imported by a package, and the root `pnpm-lock.yaml` does not name it. The lockfile in
this directory is its own.

The question: **where does a live assistant thread run?** Two placements, behind one event
protocol and one shared turn loop, so the only things that differ are who holds the run and
how a client attaches.

- **A. The request.** The run lives in the request that started it (`ctx.waitUntil`), a client
  attaches over SSE, and a client that comes back tails the record by polling.
- **B. A Durable Object per thread** holding a hibernating WebSocket and the run.

In both, a **record** (an event log plus a single-writer lease, standing in for
`engine-assistant`) is the source of truth: events are written first and delivered second,
and the loop reads the record to decide its next step, so a turn is resumable from the record
alone. The model is a scripted fake with configurable delay, so what is measured is what the
platform adds.

## Run

From this directory, with Node 22 and pnpm (the repo's `packageManager` is `pnpm@10.10.0`):

```
pnpm install --ignore-workspace
node run.mjs           # about 40 s; exits non-zero on a failed assertion
SLOW=1 node run.mjs    # adds a hibernation probe and two 20 to 32 s runs (about 2 min)
node bundle.mjs        # what the Lit element costs to ship
```

Results are in [FINDINGS.md](FINDINGS.md). `run.mjs` also writes `results.json`, and
`bundle.mjs` writes `bundle.json`; both are regenerated each run and git-ignored.

## Files

| File | What |
|---|---|
| `src/protocol.mjs` | Event shapes (aligned with AI SDK message parts), the approval digest |
| `src/model.mjs` | The scripted model: look up, propose a gated write, wait, execute, conclude |
| `src/record.mjs` | The stand-in for the engine: append-only log, lease, fencing |
| `src/loop.mjs` | The shared turn loop: resume from the record, restart a cut-off step, batch writes |
| `src/worker-a.mjs` | Placement A |
| `src/worker-b.mjs` | Placement B (`ThreadDO`) |
| `src/client.mjs` | Test clients that timestamp every event |
| `src/assistant-client.mjs`, `src/element.mjs` | The headless client and a minimal Lit element, for `bundle.mjs` |

## What this does not show

It runs on local workerd with a fake model and no network. Latency here says how much the
platform adds, never what a user waits. Idle cost, real eviction, the 30 s `waitUntil` cap and
the real scope database are not exercised; FINDINGS.md lists each.
