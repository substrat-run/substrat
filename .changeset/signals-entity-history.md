---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/contract-tests': minor
---

One record's history is readable above the scope (#1235, the read path).
`readHistory` has been the sanctioned way to walk an entity's events since
#800 — it pages the outbox, decodes the envelope, and keeps three nullable
facts distinct that a hand-rolled SELECT reads as missing data (an erased
payload, an unrecorded authorization chain, nobody impersonating). It was
documented in the scaffold template, the playbook and three changelogs, and
called by nothing in the repo, because nothing above the scope could reach it.

`HostAdmin.entityHistory` lands on both adapters, the vertical serves
`/internal/history` for a scope whose data it holds, and the control plane
delegates between them exactly as the table reads do. Cursor-paged rather than
offset-paged, unlike the table read: the outbox pages by id, so an event
arriving mid-walk cannot shift a page boundary and duplicate or skip an entry.
Reads are access-logged (K-24) like every other read that can name a tenant.
