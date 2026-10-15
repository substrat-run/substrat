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
3. **A gated tool runs once, with the input the user saw.** An approval is bound to
   `approvalDigest` of a tagged tuple: the deployed version, the approver (the thread's owner),
   the thread, the step, the call, the operation, an expiry, a nonce and the input
   (`docs/rfc/assistant.md` §6.0 point 3). The bindings are stored on the call, and the input
   stays in the request event. `resolveApproval` recomputes the digest with the principal who
   answers and the version the host serves the answer under, and refuses one at or after the
   expiry. `claimExecution` recomputes it with the operation, version and input the host is
   about to run, also before the expiry. Each is a conditional write (one row changed, or
   refused), so an approval is given once and spent once whatever the host's scheduling. A
   result for a gated call is refused unless it was claimed. A denial needs only the digest
   shown, so a lapsed request can always be cleared: it ends `approval_pending`, not the
   turn. Any answer resumes the turn, so the host must run after it and write `turn-finish`
   or `turn-error`; until a run does, the owner's messages are `turn_in_progress`, and the
   owner's only way out without a run is to close the thread. A host closes an abandoned turn
   the same way: take the lease once the holder is stale, and write `turn-error`.
4. **The two sides of the record are written by different keys.** The user's side (`user-message`,
   `turn-start`, `approval-resolved`) is written under `assistant:use` as the owner. The
   assistant's side is written under `assistant:run`, which a system principal holds and no
   person's role does. Even that key writes only inside a turn the user opened, so a run cannot
   keep a resting thread busy.
5. **An event is bounded** to 64 KiB, a user's message to 32 KiB, both in UTF-8 bytes as
   serialised. A large tool result stays in the operation that produced it.
6. **Erasure reaches it.** Every table that holds what a person said, or whose thread it was,
   declares its erasure by delete (K-46). Every event this engine emits is `pseudonymous`, keyed
   to the thread's owner, so the same erasure redacts its payload; and none carries text, tool
   data, a digest or the owner's id to begin with.

## Permissions

| Key | Held by | Grants |
|---|---|---|
| `assistant:use` | a person | open and read their own threads, say something, approve or deny, close |
| `assistant:audit` | staff, together with `assistant:use` | read other principals' threads, never write. Alone it grants nothing: every read checks `use` first |
| `assistant:run` | a system principal (the assistant host's) only, never a person's role | take the lease, append the assistant's events inside an open turn, claim an execution |

## Emits

`assistant.thread-created`, `turn-started`, `turn-finished`, `approval-requested`,
`approval-resolved`, `thread-closed`. Milestones only: no text, no tool input or output, no
approval digest or preview, no principal id. Each is `pseudonymous` with the thread's owner as
its `subjectId`. The per-event rows are the engine's own record.

## What it will not do

- It does not talk to a model, a network or a clock. A host does.
- It has no message branches, no participants other than the owner and the assistant, no support
  handoff and no memory yet. Each is additive: a column, an event type, a table.
- It does not decide where a live thread runs. That is the host's.
