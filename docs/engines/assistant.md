---
status: built
layer: kernel
description: The record of a chat with an assistant — an append-only event log, a single-writer run lease, and tool calls whose gated writes need an approval bound to the exact input.
---

# `engine-assistant` — the record of a chat with an assistant

Status: **built** — in the repo, composed by nothing yet; not published to npm

> Placement and reasons: [K-51](../decisions/K-051-the-assistant-s-record-is-an-engine-composed-by-call-the-run-is-host-code.md).
> Tracking: [#2283](https://github.com/substrat-run/substrat/issues/2283). The package's own
> README (`engines/assistant/README.md`) is the composing guide.

The engine is composed **by call**. A host runs the loop (the model, the tools, the streaming),
and calls the engine's in-scope functions to write what happened. The engine owns the record
and its invariants and never talks to a model.

## What it owns

- **`assistant-thread`**: one conversation, owned by one principal.
- **`assistant-event`**: one event of a thread in the stream protocol's shape
  (`assistantStreamBody`, in `contracts`), numbered from 1 per thread. Append-only.
- **`assistant-run`**: the single-writer lease on a thread.
- **`assistant-tool-call`**: the state a tool call passes through, which is where the approval
  invariant lives.

## What it guarantees

1. **The record is append-only and numbered.** The number is the cursor a client resumes after.
2. **Only the lease holder writes the assistant's side**, and a holder replaced while still
   running is fenced at its next append.
3. **A gated tool runs once, with the input the user saw.** An approval is bound to the
   SHA-256 of the input. `resolveApproval` accepts only that digest, from the thread's owner.
   `claimExecution` accepts only the input that hashes to it, and only once. A result for a
   gated call is refused unless it was claimed.
4. **The two sides of the record are written by different keys.** The user's side (`user-message`,
   `approval-resolved`) is written under `assistant:use` as the owner. The assistant's side is
   written under `assistant:run`, which no person's role holds.
5. **An event is bounded** to 64 KiB. A large tool result stays in the operation that produced it.
6. **Erasure reaches it.** Every table that holds what a person said, or whose thread it was,
   declares its erasure by delete (K-46). No event this engine emits carries text or tool data.

## Permissions

| Key | Held by | Grants |
|---|---|---|
| `assistant:use` | a person | open and read their own threads, say something, approve or deny, close |
| `assistant:audit` | staff | read other principals' threads, never write |
| `assistant:run` | the assistant host only | take the lease, append the assistant's events, claim an execution |

## Emits

`assistant.thread-created`, `turn-started`, `turn-finished`, `approval-requested`,
`approval-resolved`, `thread-closed`. Milestones only: no text, no tool input or output, and
never an approval's preview. The per-event rows are the engine's own record.

## What it will not do

- It does not talk to a model, a network or a clock. A host does.
- It has no message branches, no participants other than the owner and the assistant, no support
  handoff and no memory yet. Each is additive: a column, an event type, a table.
- It does not decide where a live thread runs. That is the host's.
