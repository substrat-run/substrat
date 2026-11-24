---
id: K-63
date: 2026-11-24
layer: kernel
title: "A tenant's people are owned by one app, and its plugins keep the master's answer for a bounded time"
status: accepted
aliases: []
amends: []
tracking: ["#3161"]
---

# K-63 — A tenant's people are owned by one app, and its plugins keep the master's answer for a bounded time

> **Accepted 2026-11-24**, from the maintainer's answers to the open questions of
> [dependent-people.md](../rfc/dependent-people.md) (§5.1, §5.2) and of
> [one-model-for-shipped-code.md](../rfc/one-model-for-shipped-code.md) (§7.3, §7.4), in phase 0 of
> that RFC. The door, the contract and the call made as a person are built on both hosts (#3161).
> What is not built is listed below.

**One app of the tenant owns its people: the master.** It decides who exists, who is blocked and
which base roles each person has. A plugin that takes its people from it (a dependent) owns none. It
has no owner claim, no invitations and no linking. It signs people in at the same issuer as every
vertical, and asks the master who each login is, through the `identity.person@1` contract
(`packages/contracts/src/people.ts`). The answer is an id, a status (`invited`, `active`, `blocked`)
and the master's role keys, or nobody. The people do not move to the tenant directory, and the
platform does not become their owner.

**A dependent keeps the master's answer for at most 300 seconds, and that is the revocation bound.**
A block or a changed role reaches every dependent within the time an answer is kept, with no
delivery guarantee needed. 300 seconds (`PEOPLE_TTL_SECONDS`) is the default. A dependency may set a
shorter time, at the cost of more calls to the master, and never a longer one. An event pushed by
the master may later be added as a faster path, and the expiry stays the guarantee. When an answer
has expired and the master does not answer, the dependent admits nobody.

**What a dependent keeps is a projection, not a second authority.** It is copied lazily, when a
person first signs in to the dependent. It is kept once per vertical and tenant, in the tenant's
identity directory, and not once per scope. The master's person id is the person's principal in the
dependent, and roles are seated per person while answers are kept per login. This is the derived
projection [kernel-design.md](../architecture/kernel-design.md) allows beside its rejection of
an authoritative copy per scope, and its weakness is stated as a number: "within the bound, or
refused", never "at once". [K-22](./K-022-the-membership-seam-is-a-connector-and-orgid-becomes-a-brand.md)
is unchanged. Membership stays in the directory, and this record covers a different fact: who a
person is, answered by an app.

**The answer carries only the authorisation half.** It holds no name and no address. The question
carries the login: the issuer, the `sub` and the address the issuer verified, so that the master can
match it. A person's name and address reach a dependent through a **platform-held profile copy**. Module code reads it and cannot
write it, and the platform erases it when the master erases the person. A dependent does not keep
names or addresses in its own tables, because that copy is one no erasure reaches. This is decided
now and built before a second plugin shows names.

**An erasure at the master reaches every dependent.** A dependent's door keeps each login's `sub`
beside the principal, and an issuer may use an address as a `sub`, so those rows are personal data.
When the master erases a person, the platform deletes that person's login rows, seat row and profile
copy in every dependent. The rows are the door's and not module code's, so the platform does it.

**A master calls its plugin as the person through the issuer, not by naming them.** It trades the
refresh token of the person's session at the master for a token addressed to the plugin on the
`peer` channel, and the plugin's door verifies that token itself, runs the person contract's check
and runs the call with the token's keys as a per-call ceiling. The plugin declares which app may act
for its people and with which keys (`delegations`), and `PERMISSIONS.md` renders it. A field on the
peer call naming the person (`actingFor`) is not used, because it lets the master assert a person
rather than prove that the person signed in to it.

## Why

**A product has to be able to be the master.** If the platform owned the people, as K-22 has the
directory own membership, a CRM could not be the system its customers keep their people in. It
would hold a reference to the platform's list. Keeping the people in an app is what lets a product
sell itself as the place people are managed, and the plugin model rests on it.

**The bound replaces a delivery guarantee the platform does not have.** An event edge between
verticals can be paused or skipped ([cross-vertical-events.md](../architecture/cross-vertical-events.md)),
and a lost block is not acceptable. An answer that expires needs nothing delivered. Failing closed
is the other half: the alternative keeps a blocked person in for as long as an outage lasts. 300
seconds is short enough for most apps. An app that needs a faster block sets a shorter time for its
dependency, rather than every app paying for it.

**The profile copy is the only answer where erasure can be shown.** A peer call per screen keeps no
copy but makes names a network call everywhere. A name cached in a plugin's own tables is a copy
the platform cannot find. A copy the platform holds, and module code only reads, is one place the
platform knows to erase.

## Built, and not built

Built ([dependent-people.md](../rfc/dependent-people.md) §4): the contract, the door
(`admitPerson`), the hosted door (`workerDoor({ people })`) keeping the copy in the tenant's identity
directory, the reference pair `demos/todo` and `demos/notes`, and the call made as a person
(`peerAs`, the delegation ceiling on both adapters).

Not built, and owed by this record:

- **The cap on the kept time.** The door takes `ttlSeconds` from its host wiring and accepts any
  value. It refuses nothing above 300 today, and a dependency does not yet declare its time.
- **The erasure reaching dependents.** Nothing deletes a person's login and seat rows in a dependent
  when the master erases them.
- **The profile copy.** No contract carries a name, and no platform-held copy exists.
- **A declaration `substrat push` reads, and an install that binds a dependent to its master.** It
  belongs to the dependency of the one-model RFC's phase 2.

## Revisit

This record is revisited if a product needs people that more than one app can block (more than one
master), if the bound proves too long for an app that cannot shorten it, or if verticals and modules
merge so that a plugin's read of its master becomes a read inside one app
([dependent-people.md](../rfc/dependent-people.md) §5.4).
