---
status: accepted
layer: kernel
description: An operation reads the caller's verified address from the platform instead of taking it as input, and a share can name an address, claimed by whoever proves it. A vertical stops writing a join, a guard, an invite table and a consumer.
---

# RFC: a verified address comes from the platform

**Status:** accepted; phase 1 in progress · **Decision:** [K-61](../decisions/K-061-an-operation-reads-the-callers-verified-address-from-the-platform-and-a-share-can-name-an-address.md)
accepted · **Tracking:** #1359 · **Touches:** `OperationContext`, both scope hosts, `vertical-auth`,
the spine, `demos/todo`, the scaffold template and the builder skills

## 1. The problem

An operation cannot see who the issuer says the caller is. `ctx` carries `principal`. The address
stops at the door: `AuthSubject` has `email` and `emailVerified`, and `identifyEmail` in
`packages/oidc-rp` decides whether the address may identify anyone. Nothing hands that answer on.

So a vertical that shares by email has to write four things itself:

1. **A `join` operation that takes `email` as input**, because no other route gives it the address.
2. **Host code that compares that input with the session**, since the operation cannot.
   `joiningAsYourself` in `demos/todo/src/app.ts` is the only copy (#1359).
3. **An invite entity and its operations**, for an address that has not joined.
4. **A consumer of the join event**, because `ctx.grant` delegates and the person joining holds
   nothing on the list.

The second is the dangerous one, because leaving it out breaks nothing a project can see. The
operation is correct, its scenario suite passes, and the suite never reaches the door. `join` then
stores whatever it was given, and the address is how a share finds a person. `model.md` already
states the consequence: a joined address is a credential.

A rule in a skill and a copy in a reference do not hold this. Generated projects still leave the
check out, and every project that gets it right holds its own copy of a security check. **This should
not be project code.** A fact the platform already holds should not be an input a project has to
remember to check.

## 2. The proposal

Two additions, both additive.

### 2.1 `ctx.verifiedEmail`

```ts
readonly verifiedEmail: string | null;
```

The address `identifyEmail` admitted for this invocation, in the issuer's spelling. Null for anything
else, and nothing else: there is no refusal reason here, because an operation has no use for one.

An operation that needs the caller's address reads it. It is never input, so there is nothing to
compare and nothing to forget.

**Who sets it.** The door, through `vertical-auth`, carried with the invocation beside the principal.
A bare `host.getScope(principal, …)` sets nothing, and the field is null.

**The rule is that leaving it out fails closed.** A door that forgets it gets null, so a person joins
nothing and claims nothing. Today a door that forgets the check lets the typed address through. That
inversion is the point of this RFC.

This is the same trust the principal has. A vertical's worker already names the principal it calls
`getScope` with, so a worker that lies about the address gains nothing it did not have. The risk being
closed is omission, not a hostile vertical.

**Null by construction**, because each of these is someone other than the person acting:

| Door | Why |
|---|---|
| A schedule, a consumer, a connection, a peer vertical, a capability holder | No person is signed in |
| Acting as a person (K-42) | Staff support must not claim what was meant for the person they view |
| A delegated token (#1824) | Another app holds the token; a ceiling on what it may do is not the person's proof |
| `OIDC_ALLOW_UNVERIFIED_EMAIL` | The break-glass admits a sign-in; it does not extend to grants (§5) |

### 2.2 Address grants

```ts
ctx.addressGrants.grant(address, permissions, entity): Promise<AddressGrantId>;
ctx.addressGrants.list(entity): AddressGrant[];
ctx.addressGrants.withdraw(id): Promise<void>;
```

`ctx.grant` names a principal. This names an address, and the kernel holds it until someone proves
that address. It follows `ctx.grant` wherever it can, and `capabilities` for the rest:

- **Delegation, never elevation.** The caller's decision on the entity is re-checked for each key,
  and a key reserved to a system principal is refused (#2430), the same as `ctx.grant`.
- **Transactional.** A grant from an operation that then throws never happened.
- **Scope-local.** A row lives in the scope's own storage, in a new spine table, so nothing crosses a
  scope and no tenant can see another's.

**Claiming.** At the start of an invocation that carries a verified address, before the guards, the
kernel looks for open rows for that address and turns each into a grant for the caller, in the
invocation's transaction. The operation that follows already sees the access.

That one step replaces several things:

- **No lookup.** A person who has joined and one who has not are handled the same way, so a vertical
  no longer asks "do they exist yet?" and needs no table to answer it.
- **No join event, and no race with one.** The claim is not waiting for anything.
- **No consumer.** The kernel holds the granter's authority in the row, which removes the reason the
  person joining could not be granted anything.
- **A binned record just waits.** A row on a trashed entity stays open and is claimed on the person's
  next call after a restore. `demos/todo` cannot do this today: a join fires once, so an invitation
  to a binned list stays open until the owner sends it again.

**The granter is re-checked at claim.** A row that waits for weeks must not outlive the authority
behind it, so a claim asks whether the granter still holds the keys, as an `act` capability does on
every use. If not, the row lapses and is listed as lapsed. Once claimed it is an ordinary grant.

**The row stays after a claim**, with its principal. `list` then answers "who has access", and
`withdraw` revokes the grant. A vertical that shows who something is shared with no longer needs its
own shares table. `platform.md`'s "a grant cannot be listed" stays true of other grants.

**On the spine.** Created, claimed, lapsed and withdrawn are events on the entity, with the actor and
the row's id. The address stays out of them and is read by id, so the outbox holds no new personal
data. **Erasure** (#37) deletes an open row and blanks the address on a claimed one.

Sending the email stays the vertical's. Its wording is the vertical's vocabulary, and `requestEmail`
already makes it transactional with the operation.

## 3. What a vertical stops writing

| Today | With this |
|---|---|
| `join` taking `email` | Gone, or a row written from `ctx.verifiedEmail` if the vertical keeps its own people |
| `joiningAsYourself` in host code | Gone |
| An invite entity, with list and withdraw operations | `ctx.addressGrants` |
| A shares table | `ctx.addressGrants.list` |
| A consumer of the join event | Gone |
| Joining on sign-in in `/api/me` | Gone |

For `demos/todo`, the seven sharing operations (`join`, `share-list`, `invite`, `list-invites`,
`cancel-invite`, `list-shares`, `revoke-share`) become three: share, list and withdraw, plus a `join`
with no address if it keeps `todo_owners`. An operation still shares, because the permission check
and the email are the vertical's. `todo_shares`, `todo_invites`, the consumer and the host check go.
All of that also leaves what a generated project has to get right.

## 4. Someone with no principal

A claim needs a caller, and a caller needs a principal. A person the tenant's identity directory has
never seen has neither, so the door refuses them before any scope is reached. `demos/todo`'s invite
has this limit today: its invitee is someone who can already sign in.

What exists does not cover it. A member invite pre-mints a principal behind a `become` link. That
link is a bearer secret, it suits joining a team rather than one record, and it gives someone who is
already a member a second identity. K-60 made `bind` for that case, and `bind` names a member who
already exists.

**Recommended: admission by address.** When a verified session has no link in the tenant, the door
asks whether an open grant waits for that address. If one does, it mints a principal with no role,
links it, and carries on. The person holds exactly what the grants give. To find the scope, a grant
also writes the address's hash and the scope to a per-tenant index, through a platform intent, so the
door never searches the scopes.

This is the expensive part, so it is its own phase (§8). Phases 1 and 2 stand without it.

## 5. Trusting an address

Everything here is as strong as the issuer's `email_verified`, and three limits should be stated:

- **An issuer is trusted for its own tenant only.** A row is scope-local, so a tenant's issuer can
  claim only inside that tenant. A tenant with a careless issuer exposes itself and nobody else.
- **Several issuers in one tenant all count.** Social sign-in beside a tenant's own issuer means
  either can assert an address, so a tenant's address trust is its weakest issuer's. This wants a
  decision (§10).
- **The break-glass does not reach grants.** `OIDC_ALLOW_UNVERIFIED_EMAIL` exists to keep people
  signed in. An unverified address claiming a share is what this RFC removes, so the field stays null.

Addresses are compared after lowercasing and Unicode normalisation, and displayed as the granter
typed them. Provider-specific rules, such as dots in a mailbox name, are not applied. A provider that
recycles an address hands the new holder what waits for it, as with any system keyed on email.

## 6. Alternatives

- **The guard in the project files.** Cheaper, and it fixes new builds. It is still a security check
  copied into every project, it cannot reach a project built before it, and it rots like any copy.
- **A guard in the `/api/invoke` door, matched on an operation named `join`.** A naming convention
  guarding a security rule. The address stays input, and a REST route or another name misses it.
- **`become` links for everyone.** Reuses the most, but module code cannot mint a principal, the link
  is a bearer secret rather than proof of an address, and a known person gets a second identity.
- **An `act` capability.** A link to one record, re-checked on use. It proves holding a link, not
  owning an address, and `demos/todo`'s concept rules out sharing by public link.
- **The address in the identity directory.** `identityLink` has no address, and a session's address is
  a fact about that session. A directory copy goes stale, and needs its own erasure.
- **A platform people engine.** Would own the person row outright. It is larger, and "person" is
  vocabulary a vertical owns. Nothing here prevents it later.

## 7. Migration

Additive throughout. A vertical that adopts nothing keeps working, with its `join`, its guard and its
tables. Engine surfaces are untouched.

Nothing here changes a deployed vertical until it is rebuilt against the new packages, so **this does
not protect one already deployed**. A vertical with a `join` keeps whatever guard it has until then.

`demos/todo` moves first, as the reference. Its `todo_invites` table stays, since migrations are
append-only, and a new migration carries open rows across. The template and the skills follow, so a
new build never meets `join` at all.

## 8. Phases

1. **`ctx.verifiedEmail`, and the refusal.** Both hosts, the door, a contract suite. `demos/todo`'s
   `join` loses its `email` input and `joiningAsYourself` goes. A `join` that takes the caller's own
   address is refused at `check_model` and at `substrat push`. The field closes the hole for a
   project that uses it, and only the refusal stops one that does not: the kernel cannot judge a
   vertical's own tables, so a typed address looked up there still reaches `ctx.grant`.
2. **Address grants.** The spine table on both adapters, the verbs, erasure, a contract suite.
   `demos/todo` moves over, then the template and skills.
3. **Admission by address** (§4), once the first two have run in a real vertical.

Until phase 1 lands, the builder keeps a gate that refuses a project whose join trusts its input. It
sits in the builder, not in the project, and the refusal in phase 1 replaces it.

## 9. How we will know

- **A contract suite on both adapters**, table-driven over the doors in §2.1: each must leave the
  field null, and each must fail to claim.
- **Claiming**, including the cases a test written from the happy path misses: a granter who lost
  access, a trashed entity, a withdrawn row, two rows for one address, a reserved key.
- **Generated builds**, run for real rather than read: an attempt to claim an address as a first act
  must fail in every build, with no project code doing the refusing.

## 10. Questions for the reviewer

| # | Question | Recommendation |
|---|---|---|
| 1 | Does an open row expire? | No, as a member invite does not. A vertical can withdraw, and erasure covers the address |
| 2 | Is a principal admitted by address (§4) a seat? | No role means no seat, until it is given one |
| 3 | Several issuers in a tenant (§5): all trusted, or a named list? | A named list in the tenant's auth settings, defaulting to all of them |
| 4 | Does a vertical need an event when a share is claimed, to tell the owner? | Yes, it is one of the spine events in §2.2, and a consumer is optional |
| 5 | Should a `join` that takes the caller's address become a `check_model` error? | Decided: yes, in phase 1, and at `substrat push` too |
