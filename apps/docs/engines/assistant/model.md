# Domain model & invariants

| Table | Owns |
|---|---|
| `assistant_threads` | Owner, title and open/closed status |
| `assistant_events` | Append-only stream bodies, numbered per thread |
| `assistant_runs` | Current writer and its heartbeat |
| `assistant_tool_calls` | Tool state and approval bindings |

All four tables declare deletion on subject erasure. Events use the
`assistantStreamBody` vocabulary from `@substrat-run/contracts/assistant-stream`.
An event is bounded to 64 KiB and a user message to 32 KiB, measured in UTF-8 bytes.

## Guarantees


- **The record is append-only and numbered.** The number is the cursor a client resumes after,
  so a dropped connection picks up exactly where it stopped.
- **One run writes at a time.** A run replaced while still running cannot write.
- **An approved call can be claimed once, with the exact approved input.** Changing the
  arguments, operation or deployed version makes the claim fail. An expired approval cannot
  be claimed, and a restarted loop cannot claim the same call again.
- **The assistant's side and the person's side are written by different keys.** A person cannot
  write an event that says the assistant said it. The assistant's key belongs to a system
  principal, never to a person's role, and writes only while a turn the person started is open.
- **A person's thread is theirs.** Anyone else is told it does not exist. Audit widens a read,
  never a write.
- **Erasing a person erases their threads.** The events the engine emits carry no text, and an
  erasure clears them too.

