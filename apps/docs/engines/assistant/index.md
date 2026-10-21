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

## What it will not do

- It cannot make a tool's external effect atomic with the execution claim. If the host stops
  after claiming but before recording the result, the record alone does not prove whether
  the tool ran. The host integration must handle that recovery boundary, and the target
  operation still checks its own permissions. Approval is not a grant of target authority.
- It does not talk to a model or a network.
- It has no message branches, human participants, support handoff or memory yet.

## How these pages are organized

- [Domain model & invariants](./model) — stored records and the guarantees they carry
- [Operations & permissions](./surface) — registered operations and in-scope functions
- [Events](./events) — emitted milestones and consumed outcomes
- [Composing & extending](./composing) — integration and host responsibilities
