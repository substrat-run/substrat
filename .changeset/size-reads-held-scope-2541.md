---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
---

The vertical-side size reads refuse a scope the deployment does not hold (#2541). `/internal/database-size` and `/internal/attachment-size` take a scope id and nothing else, and addressed the scope's storage without asking whether this deployment still held it. For a scope that was reaped, or never provisioned here, that woke an empty storage object and read it as zero. A scope this deployment does not hold, or holds only as a copy a carry wiped, is now refused `conflict` on both reads, and the storage gauge no longer reads it as a size of 0: it skips a scope the directory has since reaped or archived (or no longer has), and records every other status as that scope's error.

- kernel: `scopeNotHeldRefusal`, the one sentence both adapters refuse with.
- adapter-cloudflare: the scope DO answers `databaseSizeIfHeld` / `attachmentBytesIfHeld`, the held check and the read in ONE call (a reap or wipe cannot land between them), read without migrating, and `databaseSizeLocal` / `attachmentSizeLocal` make that one call. A wiped carried copy, which used to read 0, is refused, and so is a reaped scope's tombstone.
- adapter-sqlite: `databaseSizeLocal` / `attachmentSizeLocal`, the same two reads by scope id, refused from the directory (read once) before any store is opened; a scope with no store open or on disk is refused as the Cloudflare host's empty object is. A vertical on this host used to answer these two routes `501` (the host had no read); it now answers the size. The `501` was the "cannot read" answer the client already treats as unsupported (`StorageReadUnsupported`), and nothing pins it for a host that can.
- contract-tests: `sizeReadsContractSuite`, run against both adapters: a reaped scope, an id nothing provisioned, and a scope reaped between a listing and its read.
- control-plane-api: `isScopeNotHeld`, which recognises that 409, and `notHeldIsBenign`, the one rule for what to do with it: benign only when the directory, read now, says the scope is `reaped`, `archived` or absent (listed, then reaped). Every other status (`provisioning`, `active`, `suspended`, `archiving`) holds a store, so "not held" there stays an error, and a directory read that fails stays an error rather than a skip. The storage gauge skips on benign; the on-demand storage page reads 0, so that tenant's page can still be `complete`.

On Cloudflare a read is still addressed to the scope's object, which is constructed if it does not exist, so a refused read can leave an empty object (no receipt, no rows) that the next refusal finds the same. No wire contract changes: the routes take the same query and answer the same bytes. The only new answer is a `409` where a size used to be read from an empty store.
