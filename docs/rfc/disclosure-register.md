---
status: proposed
layer: kernel
description: Can the platform say which processors hold data about one subject? Argues #860 against the two positions it must survive; lands on not-yet-in-this-shape, and on one live erasure hole found while arguing.
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
