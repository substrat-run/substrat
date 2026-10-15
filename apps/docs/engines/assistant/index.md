# Assistant engine

`@substrat-run/engine-assistant` is the record of a chat between a person and an assistant. It
keeps the conversation as an append-only event log, gives one run at a time the right to write
the assistant's side, and makes a tool that changes something wait for an approval tied to the
exact input the person saw.

## At a glance

| | |
|---|---|
| **Package** | `@substrat-run/engine-assistant` (not yet published to npm) |
| **Entitlement key** | `assistant` |
| **Composed** | by call: a host runs the loop and calls the engine's functions |
| **Owns** | threads, their events, the run lease on each, and the state of every tool call |
| **Emits** | `assistant.thread-created`, `turn-started`, `turn-finished`, `approval-requested`, `approval-resolved`, `thread-closed` |
| **Consumes** | nothing |
| **Permissions** | 3 (`assistant:use`, `assistant:audit`, `assistant:run`) |
| **Status** | in the repo; no vertical composes it yet |

## How it is used

The engine never calls a model. A host runs the loop and writes the result through the engine:

1. A person says something: `sendMessage` appends their message and begins a turn.
2. The host takes the lease with `acquireRun`, then calls the model and its tools.
3. The host appends what happened with `appendEvents`: text, tool calls, sources.
4. A tool that changes something is proposed with an `approval-request`. Its digest binds the
   person who may approve, the thread, the call, the operation, the input, the deployed version,
   an expiry and a one-time value. The turn rests there.
5. The person approves or denies with `resolveApproval`, passing the digest they were shown.
   An approval after the expiry, or under a newer deploy, is refused; a denial always works.
6. The host takes the lease again, calls `claimExecution` with the operation and input it is
   about to run, and runs the operation only if that returns.

## What it guarantees

- **The record is append-only and numbered.** The number is the cursor a client resumes after,
  so a dropped connection picks up exactly where it stopped.
- **One run writes at a time.** A run replaced while still running cannot write.
- **A change runs once, with the input the person approved.** The model cannot alter the
  arguments or the operation after the person agreed, an approval not used before it expires
  runs nothing, and a restarted loop cannot run the change twice.
- **The assistant's side and the person's side are written by different keys.** A person cannot
  write an event that says the assistant said it. The assistant's key belongs to a system
  principal, never to a person's role, and writes only while a turn the person started is open.
- **A person's thread is theirs.** Anyone else is told it does not exist. Audit widens a read,
  never a write.
- **Erasing a person erases their threads.** The events the engine emits carry no text, and an
  erasure clears them too.

## What it will not do

- It does not talk to a model or a network.
- It has no message branches, human participants, support handoff or memory yet.
