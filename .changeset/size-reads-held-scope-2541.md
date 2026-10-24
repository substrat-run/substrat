---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

The vertical-side size reads refuse a scope the deployment does not hold (#2541). `/internal/database-size` and `/internal/attachment-size` take a scope id and nothing else, and addressed the scope's storage without asking whether this deployment still held it. For a scope that was reaped, or never provisioned here, that woke an empty storage object and read it as zero. A scope this deployment does not hold, or holds only as a copy a carry wiped, is now refused `conflict` on both reads, and the storage gauge records it as that scope's error rather than as a size of 0.

- kernel: `scopeNotHeldRefusal`, the one sentence both adapters refuse with.
- adapter-cloudflare: the scope DO's `holdsScope`, read without migrating, and `databaseSizeLocal` / `attachmentSizeLocal` ask it before they read. A wiped carried copy, which used to read 0, is refused.
- adapter-sqlite: `databaseSizeLocal` / `attachmentSizeLocal`, the same two reads by scope id, refused from the directory before any store is opened. A vertical on this host used to answer these two routes `501` (the host had no read); it now answers the size. The `501` was the "cannot read" answer the client already treats as unsupported (`StorageReadUnsupported`), and nothing pins it for a host that can.
- contract-tests: `sizeReadsContractSuite`, run against both adapters: a reaped scope, an id nothing provisioned, and a scope reaped between a listing and its read.

On Cloudflare a read is still addressed to the scope's object, which is constructed if it does not exist, so a refused read can leave an empty object (no receipt, no rows) that the next refusal finds the same. No wire contract changes: the routes take the same query and answer the same bytes. The only new answer is a `409` where a size used to be read from an empty store.
