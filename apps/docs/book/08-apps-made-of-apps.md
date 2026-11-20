# 8. Apps made of other apps

Chapter 7 stayed inside one scope. Engines and the vertical that composes them are all
modules registered in the same database. They share a transaction, they never read each
other's tables, and they cooperate through calls and events the kernel mediates.

Most tenants run more than one app, though, and since the last edition the platform has
learnt to treat that as a shape rather than a coincidence. One app can take its people from
another instead of keeping its own. The first app can call the second **as the signed-in
person**, rather than as itself. A third app can create whole tenants for its customers. This
chapter is the boundary between apps: what crosses it, as whom, and what does not.

## Two boundaries, and which one you are drawing

There are two places to put a piece of code, and the difference between them is not the
words "module" and "vertical". It is what the code shares with its neighbours.

| | A module beside yours, in one scope | Another app, in its own scope |
|---|---|---|
| Database | The same one | Its own |
| Transaction | Shared: one commit or none | Separate: no distributed rollback |
| Deploy and version | One push, one pin | Pushed, pinned and promoted on its own |
| Who it acts as | The caller, under the caller's checks | An app identity, or a person by delegation |
| Personal data in events | Ordinary, inside the scope | Only `piiClass: 'none'` crosses |
| Third-party code | Runs with yours | Runs in its own deployment |

Today an engine is a module, and a vertical is a module **plus the worker around it**: the
routes, the sign-in door (chapter 3), the app and the deploy. What an author writes for the
two is already close, and the platform may not keep two words for it. Treat the split as the
current shape rather than a promise. The property worth keeping is in the right-hand column,
last row: code someone else wrote runs in its own deployment, with its own migrations and its
own blast radius, and reaches yours only through a door that checks.

So the practical question is not "module or vertical". It is "does this need to share my
transaction?" An add-on you write yourself and sell per customer usually does. Keep it in
your vertical and gate it with an entitlement key (chapter 14). A second app pays for its
independence. Contact data does not cross in events, a connection belongs to one vertical
so a customer may connect the same system twice, and the two apps deploy separately. Reach
for one when the independence is what you want: a different owner, a different release
rhythm, or code you did not write.

## Between verticals: a call asks, an event announces

Imagine one tenant running a CRM and a board-room app. The board-room needs to show
current customer information, and to react when the CRM records a new customer. Both
apps belong to the same tenant, but each owns a separate scope database. Installing
them together does not create a shared transaction or grant access to each other's SQL.

There are two ways across that boundary:

| What the board-room needs | Mechanism | What it receives |
|---|---|---|
| An answer now: “show me this customer's current details” | A **peer call** from host code | The target operation's result, or its refusal |
| To request an operation from inside its own transaction | A **queued peer call**, written as a platform intent | A request id now; an outcome after delivery |
| To maintain its own view of facts the CRM publishes | An **event import** | Exported history, then subsequent events, from its saved position |

A call chooses an operation. An event announces a fact that has already committed.
Both use the platform's identity for an app. Neither makes the caller the signed-in
person, and neither lets two databases commit atomically.

### Follow one peer call

The board-room's server asks the CRM for `customer/get`. Three decisions happen in
different places, which is why “I declared the other app” is only part of the setup.

<CommunicationFlow kind="peer" />

First, the **caller** declares `substrat.calls: ['acme/crm']` in its package manifest.
This says where its host code intends to call. It grants nothing in the CRM.

Second, the **platform** identifies the caller from the dispatch and resolves a CRM
instance in the same tenant. It does not trust an identity or a tenant id supplied in
the request. With one eligible primary, active instance, the choice is automatic.
With several, a team admin must bind the target on the calling app's page. That choice
belongs to that particular caller instance. An unavailable bound target refuses;
the platform never silently substitutes another. Previews and forks cannot participate.

Third, the **target** declares that the board-room is a peer and may call that operation.
`peersDeclaredBy(crmOperations, { 'acme/board-room': ['customer/get'] })` derives the
permission keys from the operation declaration. The target seats those grants as
`vertical:acme/board-room`, and the operation performs its ordinary permission checks.
The declaration and its keys appear in `PERMISSIONS.md` for review.

The resulting audit actor is `{ vertical, scope }`: this app, from this instance.
The board-room still owns the decision about which of its users may trigger the call.
A peer grant does not automatically narrow itself to that user's CRM permissions.

Host code uses `peerClient('acme/crm').invoke('customer/get', input)`. An operation,
consumer or schedule cannot use that network path from inside its scope. It instead
writes a `peer-invoke` platform intent with `ctx.requestPlatform`, in the same transaction
as its own rows. Rollback removes the request too. After commit, the platform delivers
it at-least-once, using the request id as the idempotency key. The returned id is an
enqueue receipt; read the platform-request journal for the outcome.

There is a timing detail worth making explicit: **a queued call resolves its target
when it executes**. If an admin changes the binding between enqueue and delivery,
the queued call goes to the newly selected instance. A workflow that spans both apps
must represent pending, successful and failed work in its own records; there is no
distributed rollback if the second app refuses.

The tenant can switch a peer off on the receiving scope. The next call is refused,
and re-provisioning or restoring an old backup cannot quietly restore that authority.
This is a pause in permission, not a missing installation. The dashboard keeps those
states distinct. The [peer-call reference](/guide/architecture#calling-another-vertical-the-peer-door)
has the complete declarations and a runnable two-app example.

### Follow one exported event

Suppose the board-room keeps a count of customer records created in each business
category. The CRM can publish a deliberately non-personal fact for that purpose.
It must not put a name, email address or other personal data in that event and merely
label it `none`. The classification is a promise made by the producer, not a sanitizer.

The producer declares the event type it **exports** and the permission needed to read
it. The consumer declares the producer, type and `schemaVersion` it **imports**, and
registers an import handler. It parses the payload with its own schema and updates
its own tables. An ordinary emitted event with no export declaration stays local.

<CommunicationFlow kind="events" />

The important new object is the **watermark**: the last position reached in the
producer's event stream. It lives in the consumer's database, beside the data derived
from that stream. The platform asks for that position, reads exported events after it
through the producer's own code, and delivers the batch through the consumer's peer door.

Authority is checked in **both directions**. The consumer needs the export's read key
in the producer's scope. The producer needs the receiver's declared peer authority
to enter its import handler. The handler acts as the producing app and its checks
are real. The platform transports the fact; it does not waive either app's checks.

Each handler's writes and its delivery-journal row commit together in the receiving
scope. Only after processing the batch does the consumer advance its watermark.
A repeated delivery finds that journal row and skips the handler. This gives one
committed effect per event and module during ordinary delivery, even when transport
repeats. It does not extend the producer's transaction into the consumer.

Now the failure cases follow from where that bookmark lives:

| Situation | What happens |
|---|---|
| The consumer is installed later | It starts at the beginning of the retained exported history. |
| Either peer is switched off | The edge pauses; the watermark holds and the backlog waits. |
| Delivery cannot reach a deployment | The edge reports failure; the platform can try again from the held position. |
| A handler throws | Its writes roll back, a dead letter is recorded, and later events can proceed. Waiting does not retry that handler. |
| The consumer is restored to an earlier point | Its data and watermark rewind together; delivery catches it up. |
| An operator explicitly replays a range | Delivery records for that range are archived and cleared; handlers run again and can emit new effects. |

Only `piiClass: 'none'` events cross this stream. Erasure in the producing scope
cannot reach a copy a different app derived. A governed peer read is the path for
current personal information; persisting its result creates a separate responsibility
in the receiving app. Producer actor and authorization records do not travel in an
exported envelope either. The import retains source identity, and `causedBy` lets a
cause walk say where the chain continues in the other app.

Delivery matches **type and schema version**. A mismatch is withheld and dead-lettered
without exposing the payload to the handler. Classified, undecodable and over-hop-limit
events are also withheld, and the watermark moves past them. This differs from a
paused edge, which holds its position. A chain can cross at most eight vertical boundaries,
so two apps cannot keep generating work for one another forever.

### Prompt delivery, and the limits of the promise

The hosted transport is implemented. A routed response that committed exported events
can raise an export flag; the router returns the response and kicks a platform pull.
The worker's `kickFlags` helper wires this alongside the platform-intent flag from
chapter 5. Kicks are coalesced per producer with a five-second window and a trailing
pass to catch work committed during a burst. The scheduled sweep remains the backstop.

An event committed by a schedule, a peer call or another import has no routed response
to flag, so it waits for the sweep. “Usually seconds” is useful; “every event immediately”
would be an incorrect guarantee.

The current event-stream resolver still requires each end to be its vertical's unique
primary instance in that tenant. **The instance binding for peer calls does not also
bind an event stream.** Two eligible installs leave an unresolved edge.

The dashboard and console show edge health: caught up, behind, paused, unresolved or
unavailable. They also expose replay and skip. A replay deliberately runs handlers again,
so it requires an acknowledgement of that consequence; it is not an ordinary retry.
CI checks exported schemas, and a promote dropping or re-versioning an export used by
another app requires acknowledgement. That protection does not yet cover an individual
scope's `bindScopeVersion` change. These are deployed-code contracts, not just TypeScript
imports between packages in one build.


## A second app that owns no people

Peer calls and imports both act as an *app*. The board-room above still owns its people. It
signs them in, invites them, seats their roles. A **plugin** is the case where it would rather
not: a second app that adds to the first and should let in exactly the people the first app
lets in, with roles that follow theirs.

The reference pair is `demos/todo` and `demos/notes`. Notes keeps notes on Todo's items and a
shared notepad. It has no owner seat, no invitations and no members of its own. Who gets in is
decided in Todo.

### The person contract

The question one app asks the other has a name, `identity.person@1`, and it is deliberately
small:

- **In:** the login. The issuer, the subject, and the address the issuer verified, or `null`.
- **Out:** a person, or nobody. A person is the first app's id for them, a status (`invited`,
  `active` or `blocked`) and the first app's role keys.

No name and no address come back. The copy the plugin keeps therefore holds nothing an
erasure has to reach, which matters because chapter 13's erasure stops at the scope that
holds the data.

The app that owns the people implements one operation with that input and output, declares
its key `holder: 'system'` so no person's role can carry it (chapter 6), and allowlists the
plugin as a peer for it. Todo's is `todo/resolve-person`.

### The plugin's door

The plugin's half is a door, `admitPerson` from `@substrat-run/vertical-auth/people`, which a
hosted plugin mounts as `workerDoor({ people: { master, resolveOperation, roles } })`. When a
login it has not seen makes a request, the door asks by peer call and then:

- uses the id it was given as the person's **principal** in the plugin, so a note's author is
  the same id the person has in Todo;
- seats the plugin's own roles that the `roles` mapping derives from the first app's role
  keys, and removes the ones it no longer derives;
- keeps the answer for 300 seconds by default.

| The first app answers | The plugin |
|---|---|
| a person, `active` | serves them, with the mapped roles |
| a person, `active`, no roles | serves them, and every operation is `403` |
| a person, `invited` or `blocked` | `403`, and removes their roles |
| nobody | `403` |
| nothing: unreachable, with the kept answer expired | `503` |

Two properties are worth reading slowly.

**`ctx.check` still makes no network call.** Chapter 6's guarantee is untouched. The question
is asked at the door, before a stub is minted, and only when the kept answer is missing or
past its time. Inside the operation, the roles the door seated are ordinary roles in the
plugin's scope.

**The revocation bound is a number.** A block or a role change in the first app reaches the
plugin within the kept answer's lifetime, which is 300 seconds unless the door sets
`people.ttlSeconds` otherwise. Nothing caps that setting: a longer one buys fewer calls and a
slower revocation. No event delivery is involved, so no paused or skipped edge can lose a
block. And the last row of the table is the failure mode by design. With no fresh answer and
no reachable master, nobody is admitted. An outage shorter than the TTL goes unnoticed; a
longer one is a `503`, never a guess.

### A record about something the plugin does not own

A note on a Todo item is the plugin's row about the first app's entity. Notes keeps the note
and the item's id; Todo keeps the item and knows who may see it. So before Notes shows or adds
an item note, its door asks Todo a second question, `todo/vouch-access`, and answers `403`
when Todo will not vouch, the same for an item that does not exist. Module code cannot ask:
an operation has no network (chapter 4). The check happens at the door, and the operation
behind it trusts that the door asked.

That trust has a consequence the next section runs into.

## Calling the plugin as the person

Taking the people is half the shape. Until this edition the first app could only call the
plugin as *itself*: a peer call, with the first app's name on every event and the first app's
word for who the person was. Now it can call **as the person**, and the plugin can verify that
rather than take it on trust.

The mechanism is an OAuth token exchange (RFC 8693) in five steps:

1. **The first app keeps a live token for the person.** It asks for `offline_access` at sign-in
   and keeps the refresh token server-side, per session, deleted at sign-out. Hosted, that is
   `workerDoor({ refreshTokens: true })`.
2. **It exchanges that token at the issuer**, naming the plugin's client as the audience. It
   gets back a token whose subject is the person, whose audience is the plugin, whose actor is
   the first app, and which lives at most five minutes. A banned person is refused here.
3. **It calls over the peer transport** with that token attached: `door.peerAs(c, 'notes',
   'notes/add-note', { text })`.
4. **The plugin verifies the token itself**, resolves the person through the person contract
   exactly as it does at sign-in, and runs the operation as them.
5. **The kernel holds the call to a ceiling.** What was delegated is a cap applied to every
   check, on both adapters: `ctx.check`, entity checks, grant-scoped reads, `canAssign`,
   guards and derived handlers. The call can do at most what the person holds **and** what was
   delegated.

The plugin opts in by declaring it, in its manifest:

```ts
delegations: [{ actor: 'todo', permissions: ['note:read', 'note:write'], channels: ['peer'] }]
```

The declaration travels in the permission registry, so it appears in `PERMISSIONS.md` and in a
promote's permission diff. Letting another app act for your people is a widening, and chapter
6's checkpoint reads it like any other.

### The ceiling, and what it deliberately leaves out

Notes' item notes are the example worth remembering. Those operations trust the door to have
asked Todo whether the person may see the item. A delegated call does not pass that door: it
arrives already resolved. If item notes were reachable under the notepad's keys, Todo could
write a note on any item id, or read every item note, as anyone signed in. So item notes have
keys of their own that the delegation does not list, and through Todo they are `403`, even for
an administrator who holds those keys.

The general rule is the same: **leave out of a delegation any operation that relies on a check
the door made**, because a delegated call does not pass the door.

### What the record says

A delegated call's events and denials carry `delegation: { actor }` beside the person, who is
still the entry's actor. `readHistory` and `readScopeHistory` return it. Read `null` as
*nobody acted for anyone*. That covers every event a consumer or schedule emitted, and every
row written before the field existed. An absent field means an older kernel answered. Only the
actor is stored. The delegated scope can run to kilobytes per row, and the manifest and the
event's own authorization chain already say it.

### How long it can act

| What happens | When the plugin stops serving the call |
|---|---|
| The person is banned at the issuer | At the next exchange |
| The person is blocked, or loses access, in the first app | Within the person contract's TTL |
| The person signs out of the first app | At once: the refresh token is deleted |
| The person signs out at the issuer only | Not stopped, as for the first app's own session |
| A token already exchanged | Usable for the rest of its five minutes |

What it cannot do at all: act for someone who never signed in to the first app, or act from a
schedule with no session behind it. A delegated call is a person's request carried by an app,
and there has to be a person.

### Where the plugin's screens live

A person using Todo and Notes sees one app, Todo. Todo's own code draws what the plugin adds: a
Notes tab, an **Add note** under each item. When the plugin does not let someone in, Todo looks
exactly as it does without the plugin. Locally that works because both APIs sit behind one
origin. Deployed, a plugin is another origin, and how a plugin ships screens into the app it
belongs to is still an open question. Chapter 9 is about screens; that one is not answered
there either.

## An app that creates tenants

The last arrangement crosses the tenant boundary itself, and only in one direction. Some
products are platforms: one app, and every business that buys it gets its own tenant. The
seller's own admin app is a vertical in the seller's tenant, and it creates the others.

It does that with a platform intent (chapter 5), `provision-tenant`. Each created tenant
records `provisionedByTenant`, and every later intent from the manager, such as
`set-entitlements`, acts only on tenants it provisioned. Provisioning is a granted
capability. The app declares `substrat.provisions`, staff turn it on for that vertical, and
a push cannot grant it to itself.

Three details changed this edition, and each closes a window someone could use.

- **The owner is the verified address, with no race.** Put the address the requester's
  sign-in verified, `ctx.verifiedEmail` (chapter 4), in the payload as `instance.ownerEmail`.
  Only a sign-in whose issuer verified that address claims the new owner seat. Without it,
  whoever signs in first in the fifteen minutes after provisioning takes the seat. A
  provisioned sibling scope has the same fix: `provision-sibling` names `parentScopeId`, and
  the new owner seat is bound to the login the parent binds to that owner.
- **The new tenant can sign in at the manager's issuer.** Name one of the manager's own team
  auth servers as `instance.signIn.issuer`. The platform registers one sign-in client for the
  tenant there, delivers it, and lists the tenant on that auth server's account page for its
  members. An issuer outside the manager's tenant is refused and nothing is created.
- **The tenant gets an address.** `<tenant-slug>-<vertical>.global.substrat.run`, with a
  suffix from the scope id if the name is taken.

The manager still cannot *see* across tenants. No vertical can, including this one. A person
who belongs to several of the manager's customers switches between them on the auth server's
own account page, which lists only that person's memberships. The
[building a platform](/guide/building-a-platform) guide walks the whole pattern, including
selling parts of an app per customer.

## Extensions are planned, not built

The arrangement every platform eventually wants is customers writing additions to the app and
installing each other's. That means running one customer's code against another customer's
data, so an extension has to be its own deployed unit. It would declare what it extends and
what it needs, and a customer's admin would approve that list at install. Its screens would
run sandboxed, and it would use the customer's existing connections through an approved
capability. None of that exists. There is no extension surface, no consent screen and no
catalogue, and the guide's [extensions section](/guide/building-a-platform#extensions-planned)
says so at its top.

What does exist are the pieces such a thing would stand on, and they are this chapter. Code
that runs in its own scope, a door that decides who it serves, a contract for people it does
not own, and a ceiling on what another app may do as a person.

## What crosses, in one table

| Mechanism | Acts as | Transaction | Carries personal data |
|---|---|---|---|
| Peer call | The calling app | Separate | Yes, in the answer, under the target's checks |
| Queued peer call | The calling app | Enqueued in yours; executed in theirs | Yes, as above |
| Exported event | The producing app | Separate; at-least-once transport, one effect per event | No: `piiClass: 'none'` only |
| Person contract | The plugin, asking | None: a read, kept for a TTL | No: an id, a status, role keys |
| Delegated call | The person, capped by the delegation | Separate | Yes, under the person's own checks |
| `provision-tenant` | The manager, by intent | Separate; outcome written back | The owner address, until claimed |

---

**Next:** [Screens →](/book/09-screens)
