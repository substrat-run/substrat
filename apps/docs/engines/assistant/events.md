# Events

## Emitted milestones

All six events have `schemaVersion: 1`. Import the `AssistantEvents` type from
`@substrat-run/engine-assistant` for a vertical's consumers.

| Event | Payload |
|---|---|
| `assistant.thread-created` | `threadId` |
| `assistant.turn-started` | `threadId` |
| `assistant.turn-finished` | `threadId`, `reason` (`done`, `awaiting-approval`, `stopped`, `budget`) |
| `assistant.approval-requested` | `threadId`, `callId`, `tool` |
| `assistant.approval-resolved` | `threadId`, `callId`, `tool`, `approved` |
| `assistant.thread-closed` | `threadId` |

These are milestones, not the conversation stream. Text deltas and tool results live
in `assistant_events` and are read through `readEvents`; each delta does not produce
an outbox event.

## Personal data

Milestones contain no text, tool input or output, approval preview or digest, or owner
id in their payload. Each is `pseudonymous` with the thread owner's `subjectId` in
the envelope, so subject erasure redacts its payload as well as deleting the stored
conversation.

## Consumed events

None. The host drives the engine [by call](./composing).
