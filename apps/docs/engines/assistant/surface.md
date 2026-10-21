# Operations & permissions

## Registered operations

| Operation | Permission | Does |
|---|---|---|
| `assistant/create-thread` | `assistant:use` | Open a thread for the caller |
| `assistant/list-threads` | `assistant:use`; also `assistant:audit` for cross-owner reads | The caller's threads, most recently active first (another principal's, with audit) |
| `assistant/get-thread` | `assistant:use`; also `assistant:audit` for cross-owner reads | One thread |
| `assistant/read-events` | `assistant:use`; also `assistant:audit` for cross-owner reads | A thread's events after a cursor — how a client resumes |
| `assistant/send-message` | `assistant:use` | Say something in a thread, which begins a turn |
| `assistant/resolve-approval` | `assistant:use` | Approve or deny a gated tool call, bound to the input shown |
| `assistant/close-thread` | `assistant:use` | Close a thread; nothing more is appended |
| `assistant/acquire-run` | `assistant:run` | Take the single-writer lease on a thread (host only) |
| `assistant/release-run` | `assistant:run` | Give the lease back when a run comes to rest (host only) |
| `assistant/append-events` | `assistant:run` | Append the assistant's events to a thread, fenced by the lease (host only) |
| `assistant/claim-execution` | `assistant:run` | Claim the one execution of an approved tool call (host only) |

Engines declare no HTTP paths. A composing vertical binds operations with
`defineEngineRoutes`. Registered handlers check the permissions above.

## In-scope functions

`createThread`, `listThreads`, `getThread`, `readEvents`, `sendMessage`,
`resolveApproval`, `closeThread`, `acquireRun`, `releaseRun`, `appendEvents` and
`claimExecution` are exported for composition inside the caller's transaction.

The caller checks permissions before invoking them. In particular, `getThread` and
`readEvents` do not decide visibility: check `assistant:use` at the boundary and
call `assertThreadVisible`, which requires `assistant:audit` when the caller is not
the owner. For `listThreads`, check `assistant:audit` as well as `assistant:use`
before supplying another owner's subject. Own-thread reads require only `assistant:use`. `listThreads` returns an unpaged array; the registered
operation returns a page, ordered by most recent activity. `readEvents` returns
`{ events, lastSeq }` after the supplied sequence cursor.

## Permissions

- `assistant:use` opens threads and acts on the caller's own conversations.
- `assistant:audit`, together with `assistant:use`, widens reads to other owners.
  It never widens writes. An inaccessible thread returns `not_found`.
- `assistant:run` belongs to the host's system principal. The manifest declares
  `holder: 'system'`; a person's role cannot hold it. It drives leases, appends and claims.
