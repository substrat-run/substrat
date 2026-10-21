# Composing & extending

<CommunicationFlow kind="assistant" />

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

## Registering the engine

The package is private and available in the repository; it is not yet published to npm.

```ts
import { assistantModule } from '@substrat-run/engine-assistant';

host.registerModule(assistantModule);
```

Call the [in-scope functions](./surface) inside the host's transactions, with the
caller permissions checked at the boundary. The stream vocabulary and `approvalDigest`
come from `@substrat-run/contracts/assistant-stream`.

## Resuming after an answer

An approval or denial resumes the turn. After either answer, the host must take the
lease and write `turn-finish` or `turn-error`; until then, new owner messages fail with
`turn_in_progress`. A later run can take over a stale lease and close an abandoned
turn. Without a run, the owner's way out is to close the thread.

The execution claim cannot be atomic with a tool's external effect. Handle recovery
if the host stops after claiming, and let the target operation check its own permissions.
An approval grants no target authority.
