# @substrat-run/connector-microsoft365

## 0.0.26

### Patch Changes

- Updated dependencies [7df34ee]
  - @substrat-run/contracts@0.165.0
  - @substrat-run/kernel@0.165.0

## 0.0.25

### Patch Changes

- Updated dependencies [170078f]
- Updated dependencies [3225234]
- Updated dependencies [0e2bc1c]
- Updated dependencies [0b19237]
- Updated dependencies [2ade7ea]
- Updated dependencies [af79679]
- Updated dependencies [1e5a5af]
  - @substrat-run/contracts@0.164.0
  - @substrat-run/kernel@0.164.0

## 0.0.24

### Patch Changes

- Updated dependencies [ad35e20]
- Updated dependencies [60eb041]
- Updated dependencies [2eedfee]
  - @substrat-run/kernel@0.163.0
  - @substrat-run/contracts@0.163.0

## 0.0.23

### Patch Changes

- c077363: The Microsoft 365 and Scrive connectors read the files they send as streams (`conn.openAttachmentStream`), so a delivery never holds a whole file (#2514):

  - **Microsoft 365, files into a channel folder**: a file of up to 4 MB is read to its end before the one request that sends it. A larger file goes into its upload session one chunk at a time, so a delivery holds one 3.2 MiB chunk instead of the file. The range that commits the file is sent only once the stream has ended at its length. So bytes that fail their integrity check while they are read are never saved: the session is cancelled, and the delivery retries as any failure does. A redelivery that meets its own earlier file checks the app and the size first, and reads the bytes again for the QuickXorHash only if both match. Nothing is adopted when that read is refused.
  - **Scrive, the bound document**: the document streams into `setfile` inside the multipart body. Bytes that fail their integrity check part-way abort the request before its closing boundary, so Scrive never receives a file from them. No `start` and no ledger row follow. The draft document is left at Scrive, as on any failure after it is created.

- Updated dependencies [3310b4d]
- Updated dependencies [7d71f13]
  - @substrat-run/kernel@0.162.0
  - @substrat-run/contracts@0.162.0

## 0.0.22

### Patch Changes

- Updated dependencies [d52ad61]
- Updated dependencies [7d34c2c]
- Updated dependencies [1e7e16e]
- Updated dependencies [8bb7be5]
- Updated dependencies [2dfc19b]
- Updated dependencies [5279112]
- Updated dependencies [91a5ea1]
- Updated dependencies [81a07aa]
- Updated dependencies [14ce171]
  - @substrat-run/kernel@0.161.0
  - @substrat-run/contracts@0.161.0

## 0.0.21

### Patch Changes

- a283098: Add the provider-neutral file-source vocabulary to `@substrat-run/contracts` (#2499): `fileSourceChange` (the change a sync lands through a vertical's operation), `fileSourceWriteRequest` (the payload of the event a vertical emits to write files, with its explicit `conflict`), `fileSourceConflict`, `fileSourceUpsertAnswer` and the three caps `FILE_SOURCE_MAX_FILES_PER_WRITE`, `FILE_SOURCE_MAX_FILE_BYTES` and `FILE_SOURCE_MAX_WRITE_BYTES`. A vertical codes against these names and a second file-bearing provider lands on the same words. The Microsoft 365 connector now takes its schemas from contracts and exports them under its existing names (`microsoft365ChannelChange`, `microsoft365FilesRequested`, `MAX_FILES_PER_EVENT`, `MAX_FILE_BYTES`, `MAX_EVENT_BYTES`) as the same schema objects, so nothing about its behaviour, its event type or its payloads changes.
- 9112dd6: A streamed connector response body now times out on idleness, not on total transfer time (#2518). A connection's `fetch` used to hold one `timeoutMs` deadline (default 30 s) over the whole exchange, so a streamed provider file had to arrive in full within it however fast its bytes were flowing, and a large file on a slow link could never land. Now `timeoutMs` bounds the call up to the response headers and any buffered read (`text()`, `json()`, `arrayBuffer()`), as before. Once the body is read as a stream (looking at `body`, or taking it and never reading, releases nothing) that deadline hands over to two limits: the stream errors when the provider sends no byte for `STREAM_IDLE_TIMEOUT_MS` (30 s; an empty chunk is not a byte, and a source that makes no progress, a thousand empty chunks in a row, errors the stream too), and 10 minutes after its first read (`STREAM_MAX_DURATION_MS`) however steadily it flows. A transfer that keeps flowing can outlast `timeoutMs`, but only if it finishes within `STREAM_MAX_DURATION_MS` (10 minutes); a stalled one (idle window or empty-read bound) or one still running at the cap errors with the same `TimeoutError`, the connection is released, and an upload reading it lands no object and no row.

  The kernel exports `deadlineFetch(fetch, timeoutMs, { idleMs, maxStreamMs })` and the two constants. Both hosts wrap the connection `fetch` in it, and take an optional `streamIdleTimeoutMs` so a test can use a short window. The Scrive, Fortnox, Planima and Microsoft 365 connectors use it for their own timed `fetch` in place of `AbortSignal.timeout`.

- Updated dependencies [8e8af88]
- Updated dependencies [f0b5904]
- Updated dependencies [763957c]
- Updated dependencies [361136b]
- Updated dependencies [581a697]
- Updated dependencies [dc3b911]
- Updated dependencies [a283098]
- Updated dependencies [95bdb79]
- Updated dependencies [26db572]
- Updated dependencies [5554dad]
- Updated dependencies [279f8e8]
- Updated dependencies [c304fbd]
- Updated dependencies [69868f3]
- Updated dependencies [5147141]
- Updated dependencies [a06e284]
- Updated dependencies [ee05879]
- Updated dependencies [9112dd6]
- Updated dependencies [78a0c96]
- Updated dependencies [09c081a]
- Updated dependencies [ecbed6e]
- Updated dependencies [d5f2f9a]
- Updated dependencies [bc36021]
- Updated dependencies [286f3b4]
- Updated dependencies [5f75359]
- Updated dependencies [bc629db]
  - @substrat-run/contracts@0.160.0
  - @substrat-run/kernel@0.160.0

## 0.0.20

### Patch Changes

- Updated dependencies [6aad0fb]
  - @substrat-run/contracts@0.159.0
  - @substrat-run/kernel@0.159.0

## 0.0.19

### Patch Changes

- @substrat-run/contracts@0.158.0
- @substrat-run/kernel@0.158.0

## 0.0.18

### Patch Changes

- Updated dependencies [d0af665]
- Updated dependencies [156febd]
  - @substrat-run/contracts@0.157.0
  - @substrat-run/kernel@0.157.0

## 0.0.17

### Patch Changes

- Updated dependencies [8bbf7e9]
- Updated dependencies [c5052f9]
- Updated dependencies [55a4dae]
- Updated dependencies [1344288]
  - @substrat-run/kernel@0.156.0
  - @substrat-run/contracts@0.156.0

## 0.0.16

### Patch Changes

- Updated dependencies [6933146]
- Updated dependencies [35bdba2]
- Updated dependencies [10b7e03]
  - @substrat-run/contracts@0.155.0
  - @substrat-run/kernel@0.155.0

## 0.0.15

### Patch Changes

- Updated dependencies [bf18880]
- Updated dependencies [34c4455]
- Updated dependencies [34c4455]
- Updated dependencies [1872bb7]
  - @substrat-run/contracts@0.154.0
  - @substrat-run/kernel@0.154.0

## 0.0.14

### Patch Changes

- Updated dependencies [1a064a0]
  - @substrat-run/kernel@0.153.0
  - @substrat-run/contracts@0.153.0

## 0.0.13

### Patch Changes

- Updated dependencies [482e9b7]
  - @substrat-run/contracts@0.152.0
  - @substrat-run/kernel@0.152.0

## 0.0.12

### Patch Changes

- Updated dependencies [8273013]
- Updated dependencies [4efc88d]
- Updated dependencies [a667881]
- Updated dependencies [f614b00]
- Updated dependencies [a00c87a]
  - @substrat-run/contracts@0.151.0
  - @substrat-run/kernel@0.151.0

## 0.0.11

### Patch Changes

- Updated dependencies [57700ea]
- Updated dependencies [52cc41f]
- Updated dependencies [9024575]
- Updated dependencies [5f77e74]
  - @substrat-run/kernel@0.150.0
  - @substrat-run/contracts@0.150.0

## 0.0.10

### Patch Changes

- 0292dc0: A Microsoft 365 connection's certificate can be rotated before it lapses, without mail stopping (#2100).

  `@substrat-run/connector-microsoft365`: a save within 30 days of the current certificate's end, or one that sends `rotateCertificate: 'yes'`, generates a second keypair beside the current one. The current certificate keeps signing, and the connection's expiry stays its end. A later save signs in with the new certificate, and once Entra accepts it, it becomes the current one and the old key is dropped. If Entra refuses it, or cannot be reached, both stay as they were. Once the current certificate has lapsed, the new one takes its place at the next save. Sending signs with the new certificate when the current one has lapsed, or when Entra says the current one is no longer on the app registration. The probe signs in with the current certificate only and reports, through a check that is not recorded as the connection's health, whether Entra accepts the new certificate yet. A send's sign-in is recorded as one use, its deciding attempt, so the current certificate's expected refusal during a rotation does not count against the connection. A save that switches to the new certificate generates no further one. The credential summary shows both thumbprints and both ends. A caller can never supply either key. `prepareMicrosoft365(options)` builds the `prepareCandidate` hook with its sign-in.

  `@substrat-run/contracts`: `connectionCertificate` gains an optional `next` (`pem`, `thumbprint`, `notAfter`), the certificate being rotated in. The top-level fields still describe the certificate in use, so a consumer that ignores `next` shows the same thing as before.

- b190e40: A Microsoft 365 connection can read and write files in one Teams channel's folder of the tenant's SharePoint site (#2101).

  `@substrat-run/connector-microsoft365`: `bindMicrosoft365Scope` binds a scope to one folder, named by its drive path under the site's default document library and held by its item id from then on. A vertical writes by emitting `microsoft365.channel-files-requested` (`microsoft365FilesRequested`: a `directory` under the folder, up to 20 `files` by attachment id with each attachment's `size`, and a required `conflict` of `replace`, `rename` or `fail`). Files are at most 50 MB each and 100 MB per event, checked on the declared sizes before any byte is read (a declaration that is not the attachment's own size is refused once that attachment is read, since the platform hands over its bytes whole), and an attachment may be named once. The dispatch uploads the files one at a time, in one request up to 4 MB and by upload session above, and keeps a ledger keyed on the event id. A redelivery takes an existing file as its own only when this app wrote it and its size and QuickXorHash are the bytes being sent. A `rename` conflict uses a suffix derived from the event, never one Graph picks. `sweepMicrosoft365Files` follows the library's change feed a page at a time, saving where the next page starts after each landed page and stopping at a page budget per call (`SYNC_PAGES_PER_CALL`); a folder newly inside has its children read a page at a time under the same budget. A held item the feed does not account for (one a full pass never presents, or one a page shows somewhere it cannot place) is looked up in the drive on its own before anything lands for it, under its own budget (`SYNC_VERIFY_PER_CALL`). An item is deleted only on an answer about that item: its own deleted facet in the feed, or its own lookup finding nothing; never on a folder above it or a re-read's silence. A transient lookup error stops the pass with nothing deleted; a refusal that will not pass by itself (400, 403, an enclosing folder that cannot be read) keeps the item held, lets the pass finish, and is counted in `lastSync.unplaced`. It is asked again only on a later full pass or when the feed mentions it again, at most `MAX_UNPLACED_ATTEMPTS` times; after that it stays held as last seen, never deleted, until the scope is bound again, which clears the refusals and starts a full pass. A folder's own answer lands even while it still holds such items, which stay held. It lands each change in the folder through the binding's operation as the connection (`microsoft365ChannelChange`: `upsert`, `content` and `delete`), at least once and keyed by item id, with file contents uploaded as attachments on the entity the operation names. A path outside the folder is refused before Graph is called. Items outside the folder are never stored or logged. A deleted folder makes the binding refuse rather than fall back to the library root, and an unbind or re-bind during a pass is never written over. `registerMicrosoft365FilesConnector` and `declareMicrosoft365FilesConnector` register the dispatch on a host that runs it, or for routing only on one that does not.

  `@substrat-run/control-plane-api`: the connection bindings route takes a `folder` for a Microsoft 365 connection, and only for one. `@substrat-run/contracts`: the binding audit entry carries it. `@substrat-run/control-plane-client`: `ConnectionScopeBindingInput` gains an optional `folder`. `@substrat-run/cli`: `substrat connection bind` takes `--folder`.

- Updated dependencies [98f09fe]
- Updated dependencies [0292dc0]
- Updated dependencies [b190e40]
- Updated dependencies [eda31d1]
- Updated dependencies [af096c6]
- Updated dependencies [39ccfea]
- Updated dependencies [6f5f12b]
- Updated dependencies [754fc62]
- Updated dependencies [c7eb5fa]
- Updated dependencies [1df1b93]
- Updated dependencies [6c1e359]
- Updated dependencies [439efc1]
- Updated dependencies [e550dec]
- Updated dependencies [4574ab8]
- Updated dependencies [3025154]
- Updated dependencies [9ae6644]
- Updated dependencies [d6ba289]
- Updated dependencies [2e503da]
- Updated dependencies [3608db6]
- Updated dependencies [9ceb545]
  - @substrat-run/kernel@0.149.0
  - @substrat-run/contracts@0.149.0

## 0.0.9

### Patch Changes

- Updated dependencies [ad3ca19]
- Updated dependencies [c4a0352]
- Updated dependencies [f855218]
- Updated dependencies [a8b0842]
- Updated dependencies [00253e0]
- Updated dependencies [a9cbb6d]
- Updated dependencies [7f8c6bf]
- Updated dependencies [d175d87]
- Updated dependencies [1bf5425]
  - @substrat-run/contracts@0.148.0
  - @substrat-run/kernel@0.148.0

## 0.0.8

### Patch Changes

- Updated dependencies [9926c53]
- Updated dependencies [8ff761c]
- Updated dependencies [cb957bc]
- Updated dependencies [cb957bc]
- Updated dependencies [4d14a81]
- Updated dependencies [5b1c20f]
- Updated dependencies [1ce756e]
- Updated dependencies [b854efd]
- Updated dependencies [23840a7]
- Updated dependencies [1ad1426]
- Updated dependencies [b4bb938]
- Updated dependencies [cb957bc]
  - @substrat-run/contracts@0.147.0
  - @substrat-run/kernel@0.147.0

## 0.0.7

### Patch Changes

- Updated dependencies [381f120]
- Updated dependencies [a55d75e]
- Updated dependencies [56b0af0]
  - @substrat-run/contracts@0.146.0
  - @substrat-run/kernel@0.146.0

## 0.0.6

### Patch Changes

- Updated dependencies [e786ff0]
- Updated dependencies [f49cc49]
- Updated dependencies [6aaf822]
- Updated dependencies [bb4f18d]
- Updated dependencies [2c75a0d]
- Updated dependencies [48e9503]
- Updated dependencies [5554b23]
- Updated dependencies [3782c4c]
- Updated dependencies [fac4f0a]
  - @substrat-run/contracts@0.145.0
  - @substrat-run/kernel@0.145.0

## 0.0.5

### Patch Changes

- Updated dependencies [835409e]
- Updated dependencies [f84eb3a]
- Updated dependencies [e286f87]
- Updated dependencies [f6d671b]
- Updated dependencies [134e6c2]
- Updated dependencies [6dc8097]
  - @substrat-run/contracts@0.144.0
  - @substrat-run/kernel@0.144.0

## 0.0.4

### Patch Changes

- Updated dependencies [e55e06c]
- Updated dependencies [7eb1b3c]
- Updated dependencies [7eb1b3c]
- Updated dependencies [e55e06c]
- Updated dependencies [dfb653b]
- Updated dependencies [f1c6c9a]
- Updated dependencies [6c44d57]
- Updated dependencies [9454e61]
  - @substrat-run/contracts@0.143.0
  - @substrat-run/kernel@0.143.0

## 0.0.3

### Patch Changes

- Updated dependencies [6a81de3]
- Updated dependencies [c78098a]
- Updated dependencies [65305a1]
- Updated dependencies [c56bb34]
  - @substrat-run/contracts@0.142.0
  - @substrat-run/kernel@0.142.0

## 0.0.2

### Patch Changes

- Updated dependencies [48be1e6]
- Updated dependencies [51bb25b]
- Updated dependencies [6a05977]
  - @substrat-run/contracts@0.141.0
  - @substrat-run/kernel@0.141.0

## 0.0.1

### Patch Changes

- Updated dependencies [35dc72e]
- Updated dependencies [32df62b]
- Updated dependencies [6154fd9]
- Updated dependencies [6d49012]
- Updated dependencies [55e6241]
- Updated dependencies [13a2067]
- Updated dependencies [7b15101]
- Updated dependencies [72f8e92]
- Updated dependencies [100b47c]
- Updated dependencies [d42bb2b]
- Updated dependencies [e5bd928]
- Updated dependencies [b180d3e]
- Updated dependencies [07388df]
- Updated dependencies [ae80b0d]
- Updated dependencies [a1f40e5]
- Updated dependencies [0e3d406]
- Updated dependencies [fed1f3c]
- Updated dependencies [5405401]
- Updated dependencies [655141a]
- Updated dependencies [f1290ea]
- Updated dependencies [ced5130]
  - @substrat-run/kernel@0.140.0
  - @substrat-run/contracts@0.140.0
