---
"@substrat-run/control-plane-api": minor
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/adapter-sqlite": minor
"@substrat-run/contract-tests": minor
"@substrat-run/contracts": minor
"@substrat-run/kernel": minor
---

feat(platform): a data subject can finally be erased, and the backups cannot un-erase them (#37)

`piiClass: none|pseudonymous|direct` has been enforced at the type level since the contracts
package existed: an event that could carry PII cannot be declared without a `subjectId`, and
the Zod message says why — *"crypto-shredding must be able to key the erasure"*. The
classification was total by construction. The erasure it keys did not exist anywhere in
`packages/`. `demos/hr` seeds real-shaped national IDs against a comment promising a
mechanism nobody had built.

**The mechanism divides the way the stores divide, not the way the data does.**

*Tier 1 is mutable, so erasing there is redaction.* `shredSubject` nulls the payload of
every classified spine row keyed to the subject and keeps the envelope — id, type, entity,
`occurredAt`, and the pseudonymous `subjectId`. That is master-plan §5.3 held exactly:
*"pseudonymous keys and transaction facts remain"*. A timeline still shows that something
happened, to what, and when. It no longer shows who, or what was said. No cryptography is
involved and none is wanted: sealing a live payload would break the raw-SQL timeline
projections CLAUDE.md explicitly blesses.

*A platform-retained copy is not mutable, so erasing there is cryptographic.* A reap backup
is full-fidelity on purpose — *"a backup that cannot restore is a false promise"* — which is
precisely why `UPDATE … SET payload = NULL` can never reach one. Each subject's payloads are
now sealed under their own key on the way into a stored copy (`sealDump`, the sibling of
`maskDump` and the opposite discipline: lossless and keyed rather than lossy and heuristic).
Destroying that one key reaches backwards into every copy already taken, and leaves every
other subject in the same copy restorable.

**Where the keys live is the guarantee, not an implementation detail.** Per-subject DEKs sit
in the **directory**, wrapped by the host `SecretBox`, never in the scope database whose rows
they protect — master-plan.md:316, *"GDPR erasure claims are only as credible as the key
store's independence"*. A key restored by the same dump that restores its ciphertext would
silently reverse every erasure the restore rolled past.

**The tombstone is what makes it an erasure rather than a delay.** A shred keeps the key row
with the key cleared, and the sealer refuses tombstoned subjects. Without that, the next
backup mints a fresh key and quietly undoes the erasure — a key store that forgets who was
erased can erase them exactly once.

**Order inside the action is fixed: redact the live spine first, destroy the key last.** Both
halves are idempotent and a crash between them converges on retry, so the tiebreak is which
half-done state harms the person — a run that died after redacting leaves ciphertext nobody
can open; destroying the key first would leave their PII in the live database while the audit
log already claimed they were erased.

New on `HostAdmin`, implemented by **both** adapters with the crypto factored into the kernel
(`createSubjectKeys`) so an adapter supplies three row operations and no cipher:
`shredSubject`, `sealSubjectPayloads`, `openSubjectPayloads`. New `shredSubject` admin action,
carrying a receipt (`eventsRedacted`, `keyDestroyed`, `tombstoned`) as its `after`. Audited in
**both** logs — the admin log because it is a mutation, the access log because it destroys
evidence, and an erasure is the one action where *who asked for this to disappear* is itself
part of the record.

`POST /tenants/:t/scopes/:s/subjects/:id/shred` is staff-only and absent from
`BUILDER_ROUTES`: a builder forwards the DSAR and the platform executes it, which is where
hosting-and-certification.md §3 already draws the line (*"we provide extraction, they define
scope"*).

**Five limits ship as documentation, not as backlog** (kernel-design §13.1, closing open
question 17's spine half). One subject per event, so *"erase Jens Palmgren from everywhere"*
is still out of reach. Vertical-owned tables are untouched — `hr_employees.national_id` needs
the `onSubjectErased` hook that is deliberately a separate issue. Copies already handed to a
customer, and backups taken before sealing existed, are beyond reach. A PITR rewind restores
the pre-redaction state. A directory restore can resurrect a key, and the admin log — the
compliance witness, never swept — is what records which erasures must then be re-applied.

The acceptance criterion is a round trip rather than a claim: back up a scope, shred one of
its two subjects, read the same stored copy back, and watch that subject's payloads open to
nothing while the other's restore intact.
