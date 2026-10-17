---
'@substrat-run/contracts': patch
'@substrat-run/kernel': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
'@substrat-run/vertical-host': patch
'@substrat-run/control-plane-api': patch
'@substrat-run/docs': patch
---

Attachment bytes that no row points at can now be swept, and nothing can sweep the bytes of a row that committed.

**The sweep.** `host.sweepOrphanAttachments(tenantId, scopeId, { dryRun?, limit?, copiesSettled? })` is one pass over a scope's attachment keys (`scope/<scopeId>/att/<ulid>`). It deletes an object only when no `_substrat_attachments` row names it, its id is more than seven days old, and the scope is clear of its restore fence. Age and fence are judged against the host's own clock (`clock` on the pure adapter, `orphanSweepClock` on the hosted one, both set at construction). A pass takes no instant from its caller. The scope condemns each candidate first, in one transaction, into the new spine table `_substrat_attachment_condemned`. Only a condemned object is deleted. A dry run condemns and deletes nothing and reports the keys a pass would delete. Other scopes' keys, other features' keys and malformed keys in the same bucket are never judged. Both adapters implement it. Nothing runs it on a schedule yet: the platform's pass is a separate change.

**An upload whose id was condemned is refused.** Both adapters' attachment insert, an upload-link redemption included, refuses a condemned id in its own transaction (`conflict`, reason `attachment_condemned`). So an upload racing a pass fails instead of committing a row without its bytes. A restore or carry whose dump would bring back a row for a condemned id is refused the same way, before anything is dropped. `pnpm lint:attachment-writers` refuses a new writer of attachment rows that skips either check.

**A rewind or a restore now refuses when its fence cannot be written.** This is a behaviour change. Every PITR rewind and every restore of a scope first writes a fence object into the tenant's attachment bucket, and the sweep deletes nothing of that scope for 35 days after it, because a Durable Object keeps 30 days of point-in-time history. If the fence cannot be written, the rewind or restore is refused before anything is replaced: availability is traded for never losing a restorable row's bytes. The error says so, and the operation can be retried once the bucket answers. A rewind also refuses a scope that holds files and whose tenant it cannot tell. The control plane now names the tenant on `/internal/rewind`, and otherwise the scope's own provision receipt does.

**Only the scope's own live copy judges.** Both adapters refuse a scope that is not active (archived, reaped, or under a suspended tenant) and a fork or a preview. With a directory, the hosted adapter reads the scope's record before it addresses the scope's storage, so a reaped scope is never woken. Its scope object also refuses on its own when its storage was reaped, when its delivered lifecycle is not active, when it holds nothing at all, when it is a copy a carry wiped or kept, and when its provision receipt does not name the tenant.

**No pass while another script's copy is unsettled.** While the copy ledger holds any entry for the scope that is not `done` (pending, eligible, kept, retained, or a state added later), the pass is refused, because that copy may hold rows, uploads among them, that the serving copy lacks, or may still turn one up. `done` is the only settled state (`SETTLED_COPY_STATES`, an allowlist). A deployment with no directory cannot read the ledger, so it refuses unless its caller says it checked (`copiesSettled: true`).

**What the sweep cannot protect.** A restore from a dump older than 35 days can bring back rows whose bytes were swept, the same exposure a removed attachment already has.

`orphanSweepContractSuite` holds each guard on both adapters with the others out of play: a pass racing a held upload, an in-flight upload a pass leaves alone, a restore the fence protects, and a fork and a foreign tenant refused. The hosted adapter's own cases cover the receipt, the copy markers and the rewind fence. `SqliteScopeHostOptions.wrapBlobStore` lets a deployment or a test wrap the per-tenant store.
