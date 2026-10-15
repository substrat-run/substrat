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

// A change waits for approval: the request carries the digest of its input.
//   { t: 'approval-request', callId, tool, input, digest: await approvalDigest(input), preview }
// The person approves with the digest they were shown (assistant:use, as the owner).
resolveApproval(ctx, { threadId, callId, digest, approved: true });

// Before running the operation, the host claims its one execution with the input to run.
await claimExecution(ctx, { threadId, runId, callId, input });
```

`approvalDigest` and the event vocabulary (`assistantStreamBody`) are in `@substrat-run/contracts`.

## Two keys

`assistant:use` is a person's: open and read their own threads, say something, approve or deny.
`assistant:run` is the host's, and **no person's role should hold it**: it writes the assistant's
side of the record. `assistant:audit` reads other principals' threads and never writes.

## What it guarantees

See `docs/engines/assistant.md` in the repository. In short: an append-only numbered record, a
fenced single writer, an approval bound to the input digest with a single claimed execution,
bounded events, and erasure by delete.
