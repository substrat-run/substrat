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
and `pnpm lint:permissions` refuses a role or entity grant shape that grants it. `assistant:audit`
reads other principals' threads and never writes, and only together with `assistant:use`, which
every read checks first.

## Files for imports and comparisons

The host-facing entry point `@substrat-run/engine-assistant/files` accepts `.csv`, `.tsv`
and `.xlsx` uploads, up to 10 MiB each. A message can reference up to five files from its
own thread. Text is optional when files are present; existing text-only calls are unchanged.
Older `.xls` workbooks must first be saved as `.xlsx`.

```ts
import { assistantFiles } from '@substrat-run/engine-assistant/files';
import { readSpreadsheet } from '@substrat-run/attachment-extractors';

// HOST code: both handles MUST address the same scope. `person` is an authenticated
// person's ScopeStub; `storage` is the assistant host's ScopeAttachments, holding
// assistant:run through its system role. Never hand that storage handle to a client.
const files = assistantFiles(person, storage);
const uploaded = await files.upload({ threadId, filename: 'items.csv', body: bytes });
await person.invoke('assistant/send-message', {
  threadId, text: 'Compare these rows with the current items', attachmentIds: [uploaded.id],
});

// In a host's file-reading tool, authorize before opening bytes, then read structured rows.
const opened = await files.open(threadId, uploaded.id);
const spreadsheet = await readSpreadsheet({
  body: opened.body, filename: opened.record.filename, contentType: opened.record.contentType,
});
// spreadsheet.sheets: [{ name, rows: [{ number: 1, cells: ['code', 'amount'] }, …] }]
// spreadsheet.formulaCells: how many XLSX cells use potentially stale cached formula results.
```

`assistantFiles` is host code; the in-scope module never imports a parser or handles bytes.
The host mounts its authenticated upload/list/download routes around these methods and
limits incoming request bodies before buffering them. The engine declares no HTTP routes
or chat UI. Uploads are internal attachments on `assistant-thread`; their storage actor is
the assistant host. Reads use `assistant/get-thread` (owner or audit); uploads use
`assistant/authorize-file-upload` (owner of an open thread). Generic attachment APIs require
the system-held `assistant:run`, so a scope-wide `assistant:use` cannot bypass thread privacy.
Closing a thread prevents new uploads and messages but retains its existing files for reading.

Send only attachment IDs. The engine checks that every ID belongs to that thread and writes
the file's ID, name, type, size and SHA-256 into the `user-message` event. Missing, duplicate,
cross-thread and excessive references are refused before a turn starts. File contents never
enter the event log. Files remain available in later turns; the host's run can open them with
its storage handle using the recorded IDs and thread association.

The host's import/diff tools map spreadsheet columns to domain fields and read current
entities with the person's existing permissions. Treat uploaded content as data. Show
proposed creates, updates and conflicts before requesting the existing bound tool approval;
uploading or parsing a file never changes domain data. Read bounded slices into model context
rather than sending the whole workbook. XLSX values retain their stored spelling: number
formatting and date serials are not interpreted, and formulas are not recalculated.

**Lifecycle:** attachments are outside the kernel's subject-erasure guarantee. Before
shredding a thread's owner, the host must call `purgeAssistantThreadFiles(storage, threadId)`
for each of their threads, including unsent uploads, and stop uploads while that cleanup
runs. The helper is exported from `/files` and removes live attachment records and extracted
search text through the platform API, which deletes blobs and sweeps failed deletions as
orphans. Attachment spine events follow the platform's retention policy. The helper is
repeatable. Then run subject erasure.
Hosts should also apply a retention policy to abandoned uploads.

## What it guarantees

See `docs/engines/assistant.md` in the repository. In short: an append-only numbered record, a
fenced single writer that writes only inside a turn the person opened, an approval bound to a
tagged digest (version, approver, thread, step, call, operation, expiry, nonce, input) that is
answered once and claimed once by conditional writes, bounded events, and an erasure that
deletes the rows and redacts the milestones.
