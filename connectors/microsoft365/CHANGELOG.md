# @substrat-run/connector-microsoft365

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
