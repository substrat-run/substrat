# @substrat-run/engine-assistant

The record of a chat between a person and an assistant, for [Substrat](https://github.com/substrat-run/substrat).
An append-only event log, a single-writer run lease, and tool calls whose gated writes need an
approval bound to the exact input.

**Not published yet** (`private: true`). Nothing composes it yet; it is the first part of the
assistant described in [#2283](https://github.com/substrat-run/substrat/issues/2283).

## How a host uses it

The engine is composed **by call** and never talks to a model. A host runs the loop and calls
the in-scope functions inside its own transaction, as a principal holding the right key:

```ts
import { assistantModule, sendMessage, acquireRun, appendEvents, claimExecution, resolveApproval } from '@substrat-run/engine-assistant';

host.registerModule(assistantModule);

// A person (assistant:use) says something, which begins a turn.
sendMessage(ctx, { threadId, text });

// The host (assistant:run) takes the lease and appends what the assistant did.
acquireRun(ctx, { threadId, runId });
await appendEvents(ctx, { threadId, runId, events: [{ t: 'text-start', pid: 'p1' }, /* … */] });

// A change waits for approval. The request carries what it binds and their digest, with the
// thread's owner as the approver:
//   digest = await approvalDigest({ version, approver: threadOwner, thread: threadId, step,
//                                   call: callId, operation, expiresAt, nonce, input })
//   { t: 'approval-request', callId, step, tool, operation, version, input, expiresAt, nonce, digest, preview }
// The person approves with the digest they were shown (assistant:use, as the owner), on a
// route the loop cannot call; `version` is the deployed version the HOST serves the answer under.
await resolveApproval(ctx, { threadId, callId, digest, approved: true, version });

// Before running the operation, the host claims its one execution with what it is about to run.
await claimExecution(ctx, { threadId, runId, callId, operation, version, input });
```

`approvalDigest` and the event vocabulary (`assistantStreamBody`) are in
`@substrat-run/contracts/assistant-stream`.

**After every answer, the host runs.** An `approval-resolved`, approval or denial, resumes the
turn rather than ending it, so the owner gets `turn_in_progress` until a run writes
`turn-finish` or `turn-error`. A host therefore takes the lease after every answer, a denial
included, and ends the turn (`turn-finish: done` after a denial, or `turn-error` if it cannot
go on). If a turn is abandoned, because the host never came back, a later run takes the lease
once the holder is stale and closes it the same way. The owner has no way to end a turn
without a run; closing the thread is their only way out.

## Two keys

`assistant:use` is a person's: open and read their own threads, say something, approve or deny.
`assistant:run` is for a **system principal only** (the assistant host's), never a role a person
holds: it writes the assistant's side of the record. The manifest declares it `holder: 'system'`,
and `pnpm lint:permissions` refuses a role or entity grant shape that grants it. `assistant:audit` reads other principals' threads and
never writes, and only together with `assistant:use`, which every read checks first.

## What it guarantees

See `docs/engines/assistant.md` in the repository. In short: an append-only numbered record, a
fenced single writer that writes only inside a turn the person opened, an approval bound to a
tagged digest (version, approver, thread, step, call, operation, expiry, nonce, input) that is
answered once and claimed once by conditional writes, bounded events, and an erasure that
deletes the rows and redacts the milestones.
