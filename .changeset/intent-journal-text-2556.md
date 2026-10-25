---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
'@substrat-run/control-plane': patch
---

A platform intent's journal no longer carries text from beyond the scope that raised it (#2556, after #2554). The scope's vertical reads that journal (`lastError`). Three intents can fail with text that belongs to another deployment or another tenant: a peer call answered by the target vertical's deployment, and `provision-tenant` and `set-entitlements` once they act on the managed tenant and its deployment. For those, the journal now says what failed and at which step, under the platform's own reference, for example `the call to 'crm' (operation 'customer/list') did not complete at its deployment (reference <ulid>)`. The failure's text goes to a staff-only ops-failure row under the same reference. The journaled attribution keeps its origin and code, but no longer a permission key read from that text.

- **A pass that leaves the intent pending** files staff's row once per intent and sentence (`stage` `transient`). The row opens with the sentence the scope was told (`platform intent <id> pending (<sentence>): <text>`), after the upstream marker. The marker is read from the failure's own text alone, because a sentence can quote the caller's input (a peer call's operation). Marker spellings in the opening are neutralised. A later pass whose sentence is the one its previous settle journaled reuses that reference for 24 hours, after one ledger read by the reference confirms the row, and files nothing. So a stuck intent reaches the staff digest once a day, not on every pass. A pass that fails at a different step journals a different sentence, so it files its own row under a new reference. If the ledger cannot be read, the pass files anew and leaves staff a `transient-lookup` note naming the reference it could not confirm.
- **A terminal settle or the attempt ceiling** files the pair it already filed (#2554), and the journal names that pair's reference.
- **Every other refusal** the platform writes about the scope's own tenant (an undeclared peer, a target that is not installed, a refused payload) is journaled as before. The one exception is `set-entitlements` finding no deployment for the managed scope. It now names the payload's own ids (`no deployment is bound for scope <id> of tenant <id>`), not the vertical that scope runs.

The tenant slug refusal no longer names the tenant that holds the slug, on either adapter: `tenant slug '<slug>' is already taken (slugs are unique)`. Subject erasure reaches the new staff row as it reaches a pair. In the kernel, `withheldStaffFailure` builds that row. It takes an optional `opening`. In contracts, `withUpstreamReference(raw, opening?)` puts that opening after the marker, `neutralUpstreamMarkers` neutralises marker spellings, and `withoutUpstreamReference` reads a staff row's text past its marker.
