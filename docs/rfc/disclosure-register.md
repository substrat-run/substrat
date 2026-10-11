---
status: proposed
layer: kernel
description: Can the platform say which processors hold data about one subject? Argues #860 against the two positions it must survive; lands on not-yet-in-this-shape, and on one live erasure hole found while arguing. Revision 2 takes the forks and recommends a derived register plus a declared superset.
---

# RFC: the disclosure register — who holds a copy, and what we may say about it

**Status: proposed. Nothing here is agreed.** It answers
[#860](https://github.com/substrat-run/substrat/issues/860), which asks for an RFC before
implementation *"because it has to argue against two positions already recorded rather than
around them"*. This document lays the forks out and deliberately does not take them; where
it has a recommendation it says so in those words. A human ratifies by rewriting this into
`architecture/` with a decision entry, or by closing it — and per the
[`rfc/` rule](../README.md), a document that never leaves this directory is itself telling
you something.

**Revision 2 (2026-10-11) is §8.** It leaves §1–§7 as argued. It takes the forks §5 left open,
against the tree as it stands after #1600, and recommends one shape. The status is still
*proposed*: §8 recommends, and a human decides.

It is written against `e22db55c`. Every load-bearing claim carries a file and a line on that
commit; three of the issue's own citations no longer land on the line they name and three of
its premises do not hold as written. §6 lists all of them, because an RFC arguing from a
stale tree is worth nothing.

---

## 1. What is actually being asked

One question: **which third parties hold data about this person.** A data subject asks it
under Article 15(1)(c); a controller answers it; an erasure request makes it operational,
because Article 17(2) asks the controller to *tell* those third parties.

[K-37](../decisions/K-037-subject-erasure-splits-by-store-tier-1-is-redacted-platform-.md)
built erasure and shipped its limits documented rather than discovered
([kernel-design.md §13.1](../architecture/kernel-design.md)). `shredSubject` nulls the
payload of every PII-bearing outbox row for one subject and destroys that subject's DEK
(`packages/adapter-sqlite/src/index.ts:6910`–`:6942`;
`packages/adapter-cloudflare/src/host.ts:4621`–`:4642`, whose Tier-1 half is
`scope-do.ts:3599`). It reaches no store outside the scope, and it has never claimed to.

[D-46](../decisions/D-046-a-hosted-vertical-s-outbound-egress-is-a-declared-per-versio.md)
does not close the gap and, as the issue says, cannot: the egress meter's datapoint is
`index [slug]; blobs [hostname, verdict, tenant]`
(`apps/vertical-egress/src/worker.ts:146`–`:151`). A hostname says nothing about whose data
crossed.
[D-61](../decisions/D-061-do-originated-egress-is-observed-and-never-refused-d-46-s-limit.md)
— proposed, today, awaiting ratification — states the same conclusion from the other side
and hands the question here: *"It does not answer #860: a head-sampled span retained three
to seven days is a drift signal, and the compliance question still wants a durable record."*

**One premise of the issue is too strong and should not be carried forward.** It says *"today
we cannot even enumerate which processors hold one"*. We can enumerate connections, and we
can enumerate connector deliveries per scope. What we cannot do is join the two to a
**subject** — and §2 is about how nearly that join already exists.

---

## 2. Position one: outbound calls are deliberately not audited per call

Stated in its own words, in two places. `packages/contracts/src/connections.ts:204`–`:208`,
on the activity projection:

> One thing a connection **did** (#605) — a projection of the connector's own dispatch
> ledger (`listConnectorState`), which is the only durable record that an outbound call
> ever happened. The audit log deliberately holds none of this (`openConnection` is
> unaudited: one row per outbound HTTP call would drown the log that matters) […]

And `packages/kernel/src/scope-host.ts:2695`–`:2699`, on the credential read itself:

> **Takes no actor and is not audited**, the same exemption `resolveHostname` and
> `resolveIdentity` hold and for the same reason: it is a machine read on the request path,
> and an audit row per outbound HTTP call would drown the log that matters.

[connections.md §3.8](../architecture/connections.md) carries the same line at the route
level: verify *"is not audited, for §3.4's reason: it is a connection USE, and the audit log
records control-plane mutations, not outbound calls."*

**This position is not threatened, and the issue's own defence understates why.** The issue
argues the register survives because it is *subject-keyed and sparse* — written when PII
crosses, not when a call happens. True, but the stronger fact is that the register needs no
write on the outbound path **at all**, because the journal the position declines to create
already exists one level up, sanctioned by a different decision:

- A CP-less host — one constructed with no control plane (`host.ts:1406`), which is what a
  pushed vertical runs on — cannot run a connector at all: *"no connection directory, no
  credentials, no sanctioned egress"*. Each connector delivery becomes a
  `connector:<provider>` platform intent instead
  (`packages/adapter-cloudflare/src/host.ts:1577`–`:1591`;
  `scope-do.ts:3039`–`:3101`), written into the scope's own
  `_substrat_platform_requests` table **atomically with the delivery journal row**.
- `HostAdmin.dispatchConnector` says the quiet part outright
  (`packages/kernel/src/scope-host.ts:3937`–`:3939`): *"No journal here: the intent row IS
  the journal — the drain settles it done/pending from this call's outcome."*
- That row's payload is `{ executorId, event }` — the **whole `DomainEvent`**, verbatim
  (`host.ts:1590`, `ConnectorDispatchPayload`), and every PII-bearing event is required by
  type to carry a `subjectId` (`packages/contracts/src/events.ts:68`–`:79`, the refinement
  whose message is *"crypto-shredding must be able to key the erasure"*).

So a row already exists, in the scope spine, per connector **delivery** — not per HTTP call,
which is the distinction position one actually draws — carrying the provider, the subject,
the PII class, `requested_at`, `settled_at` and `status`. Nothing about reading it reopens
the settled decision. **Recommendation: whoever picks this up should say so in one sentence
and move on.** The argument the issue expected to have here is not available, because the
thing it feared to propose is already built for another reason.

---

## 3. Position two: erasure divides the way the stores divide

K-37's framing, in its own words:

> Building it surfaced the shape: **the mechanism divides the way the stores divide, not the
> way the data does.** Tier 1 is mutable, so erasing there is an ordinary redaction […] A
> reap backup or stored dump is **immutable by design** […] so a `DELETE` can never reach
> one.

The issue asks the RFC to argue a disclosure as **a third case** — a pointer to a store we do
not own — rather than a fourth tier. That argument is available and is made in §4. But it is
the wrong thing to argue *first*, because looking for the third case found something in the
first one.

### 3.1 A Tier-1 copy that erasure does not reach

`shredSubject` redacts exactly one table. Both adapters:
`UPDATE _substrat_outbox SET payload = NULL WHERE subject_id = ? AND pii_class != 'none'`
(`packages/adapter-sqlite/src/index.ts:6923`–`:6928`;
`packages/adapter-cloudflare/src/scope-do.ts:3599`–`:3612`). Nothing touches
`_substrat_platform_requests`, whose `payload` column holds a verbatim copy of the same
event, in the same scope database, for every connector dispatch. There is no `DELETE` against
that table anywhere in the tree, and no retention sweep — `listPlatformRequestHistory`
(`scope-host.ts:4008`) exists precisely so settled rows stay readable.

This is not inferred. The repo already knows those rows carry PII: the preview-mask suite
pseudonymises a `connector:scrive` intent payload holding party labels
(`packages/control-plane-api/test/mask.test.ts:293`–`:304`), and the connection relay's own
comment gives the reason a credential must not ride an intent — *"an intent payload lives in
the scope's spine, and with it in every export, backup, and PITR window"*
(`apps/control-plane/src/worker.ts:1436`–`:1437`).

**This is a defect under K-37 as written, not a new case.** A mutable table in the live scope
database is Tier 1; Tier 1 is redacted; this one is not. It needs no register, no decision
and no new column — only the same `UPDATE`, against a JSON payload, keyed the same way.
**Recommendation: fix it under K-37, separately from #860 — filed as
[#1600](https://github.com/substrat-run/substrat/issues/1600).** Three things a fixer
should decide rather than discover. The column is `payload TEXT NOT NULL`
(`packages/adapter-sqlite/src/index.ts:531`; `scope-do.ts:335`), so the outbox's
`SET payload = NULL` does not transfer — redaction here has to *replace* the JSON, which
makes "what a redacted intent looks like" a shape someone has to choose. A pending row would
then be drained with its payload gone, so argue for redacting settled rows only, or for
settling first. And the same walk is owed over every other intent kind before anyone claims
Tier 1 is complete.

### 3.2 And limit 3 does not say what the issue says it says

The issue names *"copies already handed out"* as the limit this work closes. §13.1 limit 3
reads:

> **Copies already handed out are beyond reach.** A `?full=true` export a customer holds is
> theirs; so is any backup taken *before* sealing existed […]

Neither example is a processor. The recorded limit is about the **customer's own export** and
about **pre-sealing backups**. A copy sitting at Scrive is not enumerated in §13.1 at all —
which makes the gap *larger* than the issue claims, not smaller, and means the honest edit
is a new limit rather than a footnote to an existing one. (The issue also says five limits;
there have been six since #1527 added the Tier-2 lake.)

---

## 4. The third case, argued

A disclosure is neither Tier 1 nor a sealed platform copy. Both of K-37's cases are about a
store **we operate**, and the mechanism in each follows from who holds the write: mutable and
ours ⇒ redact; immutable and ours ⇒ seal on the way out and destroy the key. A processor's
copy is neither, so neither mechanism has anything to bite on. What is available instead is
*strictly weaker and should be named as such in any text that ships*: a **record of the
edge**, plus a **request** that the other end act on it.

That is a third case rather than a fourth tier because a tier is a store the erasure reaches.
This one is a store the erasure can only **point at**. K-37's closing discipline is the
constraint on how it may ever be described — *"That's a real Article 17 scenario. Don't
promise it"* — and the issue is already honest about this: what lands is *"we told every
processor we know we told"*.

---

## 5. The forks, laid out and not taken

**F1 — Where the record lives.** Three candidates, in increasing cost. (a) **Derive it**:
a projection over `_substrat_platform_requests` joined to `_substrat_outbox`, no new
storage, available for history already written. (b) **A spine table**, as the issue sketches
— `(connectionId, subjectId, dataClasses, occurredAt)` — which buys a narrow shape at the
price of a new writer on a path that has one. (c) **The directory**, where connector
bookkeeping already lives for a structural reason: a connector *"cannot record 'already did
this' in the scope, because a connector runs inside the scope's dispatch and re-entering the
scope actor deadlocks"* (`scope-host.ts:2727`–`:2731`). That hazard does not apply to the
platform drain, which settles into the scope from outside — but it is the reason the issue's
sketch of "the executor writes a disclosure row in the scope spine" cannot be taken as
written for the self-hosted, in-process path. **Recommendation: derive before you store.**
Build the read, see what it cannot answer, and let that decide whether a column is owed. F2
and F3 are what the derived read cannot answer.

**F2 — What counts as a disclosure.** The intent row records that the platform handed a
connector an event and how the delivery settled. It does not record what the connector
*sent*: a connector may send a subset of the payload, or more than it, since it holds
`ctx.admin` and an opened connection. "Delivered" is also not "received and retained" —
`status: done` means our call returned. Anyone writing a DSAR answer off the derived read
is answering a narrower question than the one asked, and the document must say which.

**F3 — Declared classes, or observed ones.** The issue's step 2 —
`discloses: ['contact.email','contact.name']` on the connector manifest, rendered at the
admit checkpoint in D-39's shape — is expressible today: `ConnectorRegistration`
(`apps/control-plane/src/connectors.ts:118`–`:177`) is where `grants` already lives, and the
rule there is that the list is read from the connector's own exported constant, never
re-listed, *"a second copy is how the dashboard catalog came to disagree with the connector
(#716)"*. A declared list is auditable at admit, cheap, and always a **superset** — it says
what this connector may disclose, never what it did for this person. An observed list is
truthful and requires each connector to report what it sent. They answer different questions
and a register may want both; nothing decides that here. Note the reach, too: `CONNECTORS`
is a closed platform-side set of three (`connectors.ts:347`), so a declared register covers
connectors we write and nothing else.

**F4 — What the register covers.** The issue's step 1 makes a rule: a raw declared host
carries no direct PII, anything that does goes through a connection. **Nothing enforces that
rule today, and two live paths break it.** The email relay sends a recipient address to a
mail sub-processor and records nothing at all — no audit row, no scope row
(`apps/control-plane/src/worker.ts:1392`–`:1424`). And a vertical's own declared
`substrat.outbound` hosts are recorded only as `[hostname, verdict, tenant]`. A register
scoped to connections is defensible and much smaller; it is also *not* a complete answer to
"which processors hold data about this subject", and whoever ships one owes the reader that
sentence.

**F5 — Whose answer it is.** Article 15(1)(c) binds the **controller**, and on the hosted
product the controller is the tenant.
[D-32](../decisions/D-032-hosting-is-the-monetization-boundary-certification-inheritan.md)
leaves this open in as many words — explicitly not decided is *"whether Substrat is processor
or sub-processor per deployment shape"*. So: is the register a platform compliance artefact
(one more thing D-32's evidence export renders), or a tenant-facing read in the dashboard
that a tenant answers their own subject from? The two want different surfaces, different
retention and different words on the trust page. Note also that "register" already has a
second sense in this repo — the vendor list, as in
*"every transport is a named sub-processor with a GDPR Art. 28 transfer story, and the trust
page inherits whatever the register says"* (`docs/master-plan.md:1106`–`:1107`). That is a list of
**processors**; this is a list of **subject→processor edges**. Whichever ships should not
borrow the other's name without saying so.

---

## 6. Where the issue's premises have drifted

Checked on `e22db55c`, because two of these would send a reader to the wrong argument.

| The issue says | On `e22db55c` |
|---|---|
| `packages/contracts/src/events.ts:72` | the refinement is `:68`–`:79`; its message is `:76`. Claim holds. |
| `packages/contracts/src/model.ts:85` | correct — `erasable` is declared there, documented at `:84`. |
| `packages/contracts/src/permission.ts:96` | correct — `connectionGrant`. |
| `apps/control-plane/src/worker.ts:59` | an import line. The claim (connectors run control-plane-side) is true; cite `apps/control-plane/src/connectors.ts:347` and `packages/control-plane-api/src/platform-drain.ts:618`–`:657` instead. |
| `packages/kernel/src/scope-host.ts:427` | that is `ctx.grant`. The quoted `ExecutorHandler` docblock is `:683`–`:703`; the quote is at `:699`–`:700`. |
| `connections.ts:205` | `packages/contracts/src/connections.ts:204`–`:208`. |
| "five limits" | six since #1527. |
| limit 3 covers processor copies | it does not — see §3.2. |
| "we cannot even enumerate which processors hold one" | too strong — see §1. |

One correction that is not a citation. `ExecutorHandler`'s docblock ends *"Admin writes it
makes are stamped with the causing event's id (`causedBy`), so the split trail joins"*
(`scope-host.ts:700`–`:701`). That is the join this whole design rests on and it is already
there; the derived read of F1(a) is largely an exercise in reading a join the spine was built
to support.

---

## 7. What this RFC concludes

**Not yet, and not in the shape proposed.** Three pieces, and they should not travel together:

1. **A defect to fix now, under K-37, with no decision required** — §3.1, filed as
   [#1600](https://github.com/substrat-run/substrat/issues/1600). Erasure misses a Tier-1 copy
   in a table we own. This is the only part of #860 that is unambiguously owed.
2. **The register itself: derive first.** §2 shows the sanctioned journal already exists and
   §5/F1 recommends reading it before storing anything. A new spine table is not yet
   justified, because nobody has yet written the query that would show what it lacks.
3. **Phase three — notify on shred — is not decidable here.** It needs a per-connector
   erasure protocol that none of the three shipped connectors has, and "we told them" is a
   new outward promise, which under D-32 is *trajectory, not claim*. Argue it after (2)
   exists, or it is a schedule for a mechanism nobody has costed.

A well-argued *not yet* is the outcome this document was willing to reach. What would change
it is small and specific: write the derived read, and if it cannot answer a real DSAR for a
real tenant, that failure is the argument for the table — and it will be a better one than
this document could make in advance.

---

## 8. Revision 2 — the forks, taken (2026-10-11, against `bb4f18d78`)

**Still proposed.** This section recommends. Every fork it takes is a decision the human is
asked to confirm or overturn, and §8.8 lists the ones it deliberately leaves open. §1–§7 stand
as argued; where this section disagrees with one of them, it says so.

### 8.1 What changed since revision 1

- **§7 item 1 is done.** #1600 was fixed by #1618 and widened by #1697 (#1632). `shredSubject`
  now redacts `_substrat_platform_requests` in the same pass as the outbox, replacing `payload`
  and a non-NULL `result` with the tombstone `{"_substratRedacted": {reason, subjectId, at}}`
  and keeping the row ([kernel-design.md §13.1](../architecture/kernel-design.md), "Tier 1 is
  two tables, not one").
- **§13.1 now states twelve limits, not six.** Limit 3 still names no processor, so §3.2 holds.
- **`CONNECTORS` is four, not three**: scrive, fortnox, planima and microsoft365
  (`apps/control-plane/src/connectors.ts:431`). Fortnox declares no `dispatch`, so it never
  receives an event. microsoft365 also declares `mail` (#2098) and so can send a vertical's
  message as the tenant.
- **The email relay still writes no subject-keyed row** (`/internal/email/send`,
  `apps/control-plane/src/worker.ts`). F4's finding stands.

### 8.2 The options, compared

| | Where the record comes from | What it can say | Why not alone |
|---|---|---|---|
| **A. Record at the egress/connector boundary** (the issue's sketch) | A new spine row, written by the executor per delivery | Exactly which connection, subject and classes | A second writer beside a journal that already exists (§2). On the in-process path the executor cannot re-enter its scope (§5 F1(c)). It also records what the *executor says* it sent, which is F2's problem again |
| **B. Declared per-field disclosure in the vertical's model** | `spec/model.ts`, each field naming the connector it may reach | A field-level map, checked at compile time | It has the wrong owner. A vertical does not decide what a connector puts on the wire; the connector does, with its own `ctx.admin`. And a model declaration has no subjects in it, so it cannot answer the per-subject question at all |
| **C. Processor-side attestation** | The provider: asked "what do you hold for this reference", or asked to confirm a deletion | What the processor actually retains, which nothing on our side can know | It is a per-provider API, if the provider has one. This RFC did not verify that any of the four do, and a reply is the provider's statement, not a record we hold. It is kept as an optional upgrade inside D (§8.5) and is not the register |
| **D. Derive the edge, declare the superset** (recommended) | The journals the spine already keeps, plus a `discloses` list on each connector's registration | "Connector P was handed an event about subject S at T, and P may disclose at most these classes" | — |

### 8.3 The recommendation, and its costs

**F1, taken: derive, with no new spine table in phase 1.** An *edge* is
`(provider, subjectId, eventId, occurredAt, deliveredAt, status)`, and it is read from tables
that already exist and that the erasure already keeps as envelope:

- `_substrat_deliveries` holds one row per `(event_id, consumer_module)`, which is the executor
  id, on both the in-process and the routed path. The routed path writes it atomically with the
  intent (`packages/adapter-cloudflare/src/host.ts:2951`–`:2967`).
- `_substrat_outbox` gives that event's `subject_id` and `pii_class`, which redaction keeps.
- The host's executor registration names the executor's `provider` (`host.ts:589`). On the
  hosted path the `connector:<provider>` intent adds how the delivery settled.

The join survives an erasure: the payload is gone, and the edge is all envelope. It also covers
history already written, which a new table would not.

**F3, taken: declared, as a superset.** `ConnectorRegistration` gains
`discloses: readonly DataClass[]`, read from the connector's own exported constant, the same rule
`grants` follows (`connectors.ts:144`–`:148`), and held by the same gate that holds the dashboard
door to its registration (`lint:connector-grants`). It is rendered at the door beside `grants`
and `sendsMail`. An edge joined to it reads "may have received at most these classes". That
superset is the only class-level claim made. The observed half stays out (§8.7).

**F2, taken: name it what it is.** The read is called **connector deliveries about a subject**,
never "what the processor holds". `status: done` means our call returned. A delivery that failed
after the provider was reached counts as *possibly disclosed*, not as nothing, because a 5xx
says nothing about whether the provider stored the request.

**F4, taken: connector deliveries only, and the read says what it does not cover.** The result
carries a fixed `uncovered` list naming every other path by which a subject's data can leave:
the email relay, a vertical's declared `substrat.outbound` hosts, and a vertical's own
model-provider calls (D-59). An answer that is silent about those paths would read as complete.
Making the issue's rule ("PII leaves only through a connection") a gate is a separate decision
and is not taken here.

**Costs, stated.** It answers *handed to*, not *sent* and not *kept*. It covers the connectors
we write (three of the four receive events) and nothing a vertical reaches on its own. Its
precision is limit 1's: one subject per event, so an event about a meeting with five people is
an edge for one of them. It adds no migration and no write on any outbound path, which is why it
is cheap, and the same fact is why it can never be more truthful than the journals it reads.

### 8.4 Retention, against the erasure it supports

**This is the sharp question, and it is left open (§8.8 Q2).** Today, after a shred, the edge
already survives: the outbox keeps `subject_id`, the delivery row keeps `event_id`, and the
intent tombstone keeps `subjectId` — §5.3's *"pseudonymous keys and transaction facts remain"*,
held deliberately by #1600. The register does not create that retained identifier. It does make
it **mean more**: once it is the key to a list of processors, the surviving id answers "this
person was handed to Scrive on these dates". Three positions:

1. **Keep the raw pseudonymous id (the status quo).** For: the edge is what proves later that
   the processors were told (Art. 5(2) accountability), and what lets an erasure be re-applied
   after limit 4's PITR rewind or limit 5's directory restore. Against: a pseudonymous id is
   personal data wherever a mapping back to the person survives. Limits 2, 3 and 6 name places
   it may: a module table no erasure reaches, a pre-sealing backup, and the lake.
2. **Key it, and let the shred destroy the key.** Store each edge's subject as a keyed hash
   under the subject's own DEK. After the shred the edge can no longer be found from the id; it
   becomes an unlinkable count. Against: it breaks re-application after a rewind, which is
   exactly when the edge is needed. It needs the subject's key at every delivery, and K-37
   keeps those keys in the directory, never the scope, so every delivery would need a
   directory round-trip. And it changes nothing while the outbox row beside it keeps the raw id.
3. **Keep provider and time only.** Strip the subject from every envelope at shred. The
   per-subject answer is gone the moment it has been used once, and so is the evidence of it.

**Recommendation: 1, for now.** Keyed hashing (2) protects nothing while `_substrat_outbox`
keeps the same id beside the same timestamp, and stripping it from every envelope (3) is a
change to K-37's Tier-1 line for *every* table, not a register question. If the human wants
the id gone after erasure, that is a K-37 amendment, and the register follows it. The register
adds no retention of its own: it holds nothing beyond the journals it reads, and those are kept
indefinitely today (the only `DELETE` on any of them is an import rollback removing
deliveries of the imported events).

### 8.5 Notify on shred

**The mechanism.** `ConnectorRegistration` gains an optional `erase?(env): ConnectorEraser`
beside `dispatch`. At shred time the coordinator reads the subject's edges *before* the scope
half redacts, because afterwards an intent's `result`, which is the provider's answer and so
often its reference, is a tombstone. It then raises one `connector-erase:<provider>` platform
intent per provider that declares `erase`. That intent rides the existing drain: retry on 5xx,
no retry on 4xx, settled in the scope. Reading the edges, queueing the requests and redacting
all finish before the key is destroyed, which follows K-37's tiebreak: the half-done state that
harms the person least is "redacted here, request queued there".

**What the notice may carry.** Only the provider's own reference for the record (the document
id, the contact id the provider issued), read from the connector's state, and a fixed reason
code. Never the subject's name, address or any payload field, and never our `subjectId`, which
means nothing to the provider. A provider that can only be asked by e-mail address or name is
**not notifiable by reference**. We do not send PII to ask for PII to be erased, because that
would make a new copy at the processor and a new intent row in the spine after the redaction
that was meant to remove them. The same reasoning denies K-46's hook an `emit`. A notice also
tells the provider that this person exercised a right. That is unavoidable and is the reason
the reason code stays generic.

**What the subject gets.** The shred receipt (`subjectShredReceipt`,
`packages/contracts/src/control-plane.ts:286`) gains a defaulted `disclosures` field, counts
and states only:

- `notified`: the provider declares `erase`, and a request was queued. It is later settled
  `acknowledged` (the provider accepted the request) or `failed`.
- `not-notifiable`: deliveries exist, and the provider declares no `erase` or has no reference
  to send. The receipt names the provider, the number of deliveries and the first and last
  date, and says the platform did not contact this processor.
- `uncovered`: the fixed list from §8.3, so the receipt never implies the connector list is
  every path.

**What the platform claims about the provider's copy: nothing.** Not even under `acknowledged`.
A 2xx means the provider accepted a request. It does not mean the copy is gone, and no text in
the receipt, the dashboard or the trust page may say "erased" about a processor. Under
`not-notifiable` the controller (on the hosted product, the tenant) still owes Art. 17(2)
notice; the receipt gives them the list to do it from. That is the most the platform can
honestly hand over, and it is more than §13.1 limit 3's silence.

### 8.6 What it asks of the kernel

Two things, both on `HostAdmin`, neither on `OperationContext`:

1. **One read**, `listSubjectDisclosures(subjectId)`: the §8.3 join, implemented once in the
   kernel with a one-line shim per adapter, as `redactSubjectJobRuns` is, and held by a contract
   suite with its twin (the edges read before a shred equal the edges read after it, because
   every column the join reads is envelope). Staff and platform only; no module ever calls it. No table, no migration, so it is
   not a migration checkpoint.
2. **One receipt field**, `disclosures`, defaulted so an older receipt parses. A coordinator
   refuses a ScopeDO that predates it before touching the key, as it already refuses the
   pre-#1600 and pre-#1632 replies.

`discloses`, `erase` and the `connector-erase:*` drain are control-plane code. The kernel does
not learn what a connector is.

### 8.7 Out of scope

The observed half of F3 (each connector reporting what it actually sent). The email relay,
raw outbound hosts and model-provider calls, which are listed as uncovered rather than covered.
Enforcing "PII leaves only through a connection". Tracing (#858), which can find egress the
declarations missed but is not a record. The Tier-2 lake (limit 6). Tenant deletion (#36).
Multi-subject events (limit 1). Whether Substrat is processor or sub-processor per deployment
shape (D-32). The trust-page wording that would advertise any of this, which under D-32 is
trajectory and not claim until it ships.

### 8.8 Open questions for the human

1. **F5: whose answer is it?** A platform compliance artefact rendered into D-32's evidence
   export, or a tenant-facing read in the dashboard that a tenant answers their own subject
   from? The recommendation works either way; the surface, its permission and its wording
   differ.
2. **Retention (§8.4).** Is a pseudonymous `subjectId` surviving its own erasure acceptable,
   now that it keys a list of processors? The recommendation is yes, as K-37 already holds; a
   no is a K-37 amendment.
3. **Automatic or confirmed notice.** Should a shred send erase requests by itself, or should
   the receipt list the edges and the controller confirm before anything is sent? Art. 17(2)
   binds the controller, which argues for confirmation; an unsent request helps nobody, which
   argues against it.
4. **Is `discloses` a gate?** Should `lint:connector-grants` refuse a connector without one
   from phase 2, or warn only until all four declare it?
5. **Failed deliveries.** This section counts them as *possibly disclosed*. Is that the line,
   or should only a provider-acknowledged delivery count?

### 8.9 Phased plan

Each phase is its own PR, and each phase is useful if the next never ships.

- **P0 (done):** the Tier-1 copies are redacted (#1618, #1697).
- **P1:** `listSubjectDisclosures` on both adapters, the contract suite and its after-shred
  twin, and a staff-only route. Then write one real DSAR answer from it and record what it could
  not answer. That is revision 1's own condition for a table, and it is still the test.
- **P2:** `discloses` on each connector's exported constant, held by `lint:connector-grants`
  and rendered at the dashboard door. It does not depend on P1.
- **P3:** the receipt's `disclosures` field, with `not-notifiable` and `uncovered` only. This
  ships the honest list before any request is ever sent.
- **P4, after Q3 is answered:** `erase` for one connector whose provider supports delete by
  reference, the `connector-erase:<provider>` drain, and `notified` on the receipt. It starts by
  establishing which provider that is, which this RFC did not verify.
