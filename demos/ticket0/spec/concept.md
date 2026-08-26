# Demo Vertical — "ticket0"

Status: draft v0.1 · Last updated: 2026-08-26 · For review before any code

> An AI-assisted support desk: a chat widget you embed on your site, a support inbox that
> receives real email, and an assistant that answers from your own documentation and is
> honest about what it cost. Tenant #1 is Substrat itself — the widget goes on
> substrat.net and the knowledge base is the Substrat docs, so the demo is also the
> product's own support desk.

---

## 1. What we're building & who uses it

**ticket0** is a support desk sold to small software companies. A company signs up, drops
one script tag on its marketing site and docs, points the desk at its documentation, and
gets a support inbox. Customers ask questions in the widget or by emailing
`support@<their-domain>`. An AI assistant reads the company's docs and answers — or
drafts an answer for a human, depending on how much rope that company chose to give it.
Support staff work the inbox, take over when the assistant should not have the last word,
and see exactly how many tokens the assistant burned and what that cost.

The name is the promise: the goal is zero open tickets, mostly because most of them never
needed a human.

**The cast**, per company:

- **The desk admin** — sets up the desk. Points it at the docs, decides which sites may
  embed the widget, decides whether the assistant may talk to customers unsupervised,
  invites staff, and is the only person who sees the cost.
- **The support agent** — lives in the inbox. Reads, replies, leaves notes colleagues can
  see but customers cannot, assigns, snoozes, resolves.
- **The assistant** — not a feature, a *member of staff*. It has an account, a role and a
  name on its replies, and what it may do is granted rather than configured. More on this
  in section 4, which is the section to read twice.
- **The customer** — the person with the question. May be a complete stranger in a chat
  bubble, a known user the host site vouched for, or someone signed in to a portal. Three
  rungs, three different amounts of trust, section 4 again.

Two companies exist in the demo world, always: **Substrat** (the real one — docs at
substrat.net, inbox `support@substrat.net`) and **Kestrel Analytics** (invented, with its
own docs and its own inbox). Kestrel exists to be attacked. An isolation guarantee nobody
tried to break is a claim, not a guarantee.

---

## 2. The thing that moves through the system

A **conversation**. Not a "ticket" — the ticket is a view of the conversation once it
needs work.

A conversation starts one of two ways: someone types in the widget, or someone emails the
support address. Either way it holds an ordered list of **messages**, each of which is
either **public** (the customer sees it) or **internal** (only staff do). That single flag
is load-bearing: it is the difference between a note to a colleague and an email to a
customer, and getting it wrong is the worst bug this product can have.

The lifecycle:

```
                   ┌──────────── snoozed ────────────┐
                   │  (wakes on a timer or a reply)  │
                   ▼                                 │
  new ──────► open ──────────────────────────► resolved ──────► closed
               ▲                                  │
               └────────── reopened ──────────────┘
                     (customer replies again)
```

- **new → open** happens the moment anyone — assistant or human — takes it seriously.
- **open → snoozed** parks it. It comes back on its own; that is the point.
- **resolved is not the end.** A customer who replies to a resolved conversation reopens
  it, in the same thread, with the same history. This is the single most important thing
  about the lifecycle and the reason a conversation is *not* a work order (section 3).
- **closed** is the end, and only time or a human puts it there.

Two transitions must not be skippable, and they are the ones a naive implementation gets
wrong: nothing reaches `resolved` without at least one public reply having been sent, and
nothing reaches `closed` except from `resolved`.

Conversations also **merge** — the same person asking the same thing twice in two channels
is one problem, not two. A merged conversation keeps its history and forwards to its
survivor; it is never deleted.

---

## 3. What already exists vs. what's yours

### Free, from the platform

Most of what a support desk gets wrong is here already:

- **One company, one database.** Kestrel's conversations are not in a table Substrat's
  queries could reach with a forgotten `WHERE`. There is no cross-company API to misuse.
- **Permissions with a proof path.** Every allow and every denial records *why*. For a
  product whose core risk is "the wrong person read the wrong customer's message", this
  is the whole game.
- **The audit spine.** Every change emits a stamped event, and the conversation timeline
  is a *projection of that spine* rather than a second log the code has to remember to
  write. Support tools grow an activity feed eventually; this one is born with a truthful
  one, and it cannot silently disagree with what happened.
- **A denial log**, separate from the audit trail — so "who tried to read what they
  shouldn't" is a question with an answer.
- **Subject erasure.** A support inbox is a pile of personal data by construction. The
  platform already knows how to redact a person out of the spine on request; the desk
  inherits it instead of inventing it.
- **Migrations**, journaled and applied per company.

### Engines we compose

- **The metering engine** — the token counter, and a direct hit: its own documentation's
  worked example is literally `ai.tokens.input` keyed by a turn id. It gives us an
  append-only ledger where a retried assistant turn cannot double-count, corrections are
  compensating entries rather than edits, and a closed month is frozen evidence. This is
  the "counts tokens honestly" half of the product, and we write none of it.
- **The invites engine** — how a support agent joins a desk they are not yet in. Invited
  identifiers are stored hashed and never returned, so the invite surface can never be
  used to ask "does this person have an account here". Easy property to lose by hand.

### Engines we deliberately do *not* use

- **The work-order engine.** A ticket looks like a work order for about ten minutes:
  assign, start, complete, close. It is the wrong fit and forcing it would cost us the
  three things that make a support desk a support desk — **reopen** (a work order's state
  machine is deliberately one-way), **snooze**, and **merge**. The conversation, not the
  job, is the core noun. Worth writing down because it is the tempting wrong answer.
- **The invoicing engine.** Deferred by decision — see section 5.

### Connectors — two, both new

Vertical code may not touch the network. Anything off-box is reached by a connector, which
runs outside the database transaction.

- **An email connector, provider-agnostic, Resend first.** This is the reusable piece:
  the desk says `send(to, subject, html, text, threadRef)` and the connector maps it to a
  provider. Thread stitching — the `Message-ID` / `In-Reply-To` / `References` dance that
  makes a reply land in the right email thread — lives **in the connector**, so Resend,
  Postmark and SES all hand the desk one identical shape. The platform's existing email
  adapter is *not* this: that one sends platform mail from `substrat.run` (invites,
  password resets) and its own documentation predicts this connector by name, for exactly
  the case where a vertical needs to send business mail from a tenant's own domain.
- **An LLM connector.** Completion and embeddings behind one interface, provider as
  configuration. No model key ever enters the desk's code.

Both are outbound network destinations, so the desk declares them in its egress allowlist
per version. That is enforcement, not documentation.

### Two things the platform cannot do yet

Honest, and they are the schedule risk:

1. **A public, cross-origin surface.** The widget is served to a browser on *someone
   else's* domain. The routing half is fine — a `widget` surface alongside the `app`
   surface is an existing concept, and the shop demo already fronts two apps from one
   company's data. What is missing is **CORS handling**, of which there is none anywhere
   in the vertical host or the router, and **rate limiting** on a surface anyone can
   call. Platform work, not demo work.

   This used to say an anonymous *principal* was needed too. It is not — see section 4.
2. **Inbound webhooks.** Outbound email is an afternoon. *Receiving* email needs webhook
   ingress with signature verification and replay protection — scoped long ago, never
   built, because the one existing connector polls instead, which is fine for a signature
   ceremony and wrong for an inbox. ticket0 is the thing that forces it.

### Ours — and it is most of the app

Conversations, messages and the public/internal boundary. Contacts and the three trust
rungs. The knowledge base: ingesting docs, chunking them, searching them, citing them.
The widget itself — the embed script, the bubble, the session. The inbox UI, saved
replies, tags, assignment, snooze, merge. Notifications. The cost view. Every screen.

**Roughly: the platform gives us tenancy, permissions, audit and token accounting; the
engines give us the ledger and the invites; we build the support desk.** That is the
correct division and not a disappointment — the parts we are not writing are the parts
that would be quietly wrong for two years.

---

## 4. Who is denied what

The load-bearing section. Read it twice.

### The three rungs of customer trust

This is the design's most interesting idea and it is stolen, deliberately, from Intercom:

| Rung | How they proved it | What they can see |
|---|---|---|
| **Anonymous visitor** | Nothing. They opened a chat bubble. | Only the conversation started in this browser session. Nothing else, ever. |
| **Verified contact** | The host page's *server* signed their user id with the desk's shared secret and handed the signature to the widget. | Everything that identity has ever asked, across widget and email, without logging in. |
| **Signed-in contact** | A real login, through the company's identity provider. | The same, plus a portal they can come back to on another device. |

The middle rung is the one that makes a widget genuinely useful, and it is a *signature
check*, not a login: the host site vouches for who this is, and can only do so because it
holds a secret the browser never sees. Getting this rung wrong means one customer reads
another's support history, so it is the first thing the scenario attacks.

### The bottom rung has no account, and needs none

An anonymous visitor is **not** a user record, and the desk creates nothing on their behalf
that anybody has to clean up later. They hold a session token, and the token reaches exactly
one conversation.

That works because of a shape worth stating: the widget's operations take a session and a
token and **no conversation id**. The conversation is derived from possession of an
unguessable secret, never from anything the caller supplied — so there is no widening
attack, because there is nothing to widen. The desk's chat runs as one *widget service*
account holding a single key, which opens conversations and reaches no inbox, no contact
list and no cost figure.

The honest cost, since it is a real trade: for anything a visitor writes through the widget,
what confines them is the token rather than the permission system, and the recorded actor is
the desk's widget service rather than the individual. Who said what is on the message and
the conversation, not in the audit trail's actor field.

**Capabilities where there is no login; accounts where there is one.** A signed-in customer
in the portal is the other door, and it is the ordinary one: a real account, a grant on
their own contact, the full permission walk.

### The assistant is staff, and its authority is a grant

The assistant has an account. What it may do is granted to it, exactly the way it is
granted to a human — which means **"does the AI reply to customers directly, or draft for
a human?" is not a setting and not an `if`, it is which permissions its account holds.**

- It always holds **draft** — it may propose an answer, which is an internal message
  and cannot leave the building.
- It holds **public reply** only in a desk that granted it. Substrat's desk does. Kestrel's
  does not, because Kestrel wants a human on every outbound word.

The difference between those two desks is one grant, and the demo shows the same assistant
being refused in one and allowed in the other with no branch in the code. If we ever find
ourselves writing `if (desk.aiMode === 'auto')`, the design has failed and we should come
back to this paragraph.

### The roles

| Role | Who | Can | Cannot |
|---|---|---|---|
| `desk-admin` | The person who set the desk up | Everything below, plus: configure the desk, choose which sites may embed the widget, manage the knowledge base, invite staff, grant the assistant public reply, **and see the money** | — |
| `agent` | Support staff | Read every conversation in *their* desk, reply publicly, leave internal notes, assign, snooze, resolve, merge | **See what any of it cost.** Configure the desk. Change what the assistant may do. |
| `assistant` | The AI's own account | Read the knowledge base, read a conversation it is working, draft an answer | Send anything to a customer unless granted. Read the cost. Touch settings. Resolve. |
| `contact` | The customer | Read and reply to **their own** conversations only | See any other customer's anything. See internal notes. See the assistant's discarded drafts. |

### The two answers that must be impossible to miss

> **Who can see the money?** Only the desk admin. An agent working the inbox cannot see
> token counts, cost per conversation, or the monthly total — not the number, not the
> screen. That is one permission, held by one role.

> **Who can see another customer's data?** Nobody outside the company, ever — that is the
> database boundary, not a query. Inside the company: staff see the whole desk, and a
> customer sees only conversations tied to their own contact record. An anonymous visitor
> sees strictly less than that — only the conversation from this browser session.

---

## 5. Money & sign-off

**Metered and priced for display; no invoice.** Deliberate, and here is the shape:

Every assistant turn records its input and output tokens into the metering ledger, keyed
by the turn id so a retry cannot double-count. Each entry carries the conversation it
belongs to, so a desk admin can ask "what did this conversation cost" and "what did this
month cost". At month end the period closes into frozen per-meter lines. The desk holds a
rate card — meter key to unit price — and renders a cost. That number is *information*,
not a bill.

**What it would take to make it a bill**, written down now so the deferral is a decision
rather than a gap: the invoicing engine consumes exactly three events today, and
`metering.period-closed` is not one of them. Wiring tokens to an invoice basis means an
additive fourth consumed event on invoicing. That is permitted — engine surfaces grow
additively — and it is genuinely the "second consumer" moment that justifies extraction
rather than guessing. It is just not this demo.

**Sign-off** exists in one place and it is the assistant's: in a supervised desk, no words
reach a customer without a human sending them. Enforced as a permission, per section 4,
not as a review step someone can skip.

---

## 6. The cast, roles, and tenancy

Two companies, always.

**Substrat** — the real one, and tenant #1 in the seed world.
- Docs: the substrat.net documentation, ingested as the knowledge base.
- Inbox: `support@substrat.net`. Widget embedded on substrat.net.
- The assistant **holds public reply**. This desk runs hot.
- Cast: one desk admin, two agents, the assistant, and a handful of contacts at various
  trust rungs.

**Kestrel Analytics** — invented, and the one to attack.
- Its own docs, its own inbox, its own widget on its own domain.
- The assistant **does not hold public reply**. This desk runs supervised.
- Cast: one desk admin, one agent, the assistant, its own contacts.

Kestrel is not decoration. Every isolation claim in section 8 is a Kestrel principal
reaching for a Substrat conversation and getting nothing.

---

## 7. The data we'll store

Plain terms. Migrations are append-only forever once shipped, so this is the cheap moment
to argue about shape.

**People and companies**

- **`contact`** — a person who asked something. External id (when the host site vouched
  for them), email, display name, when they were verified, when we first saw them. Email
  and name are personal data and marked as such, so erasure knows where to look.
- **`agent_profile`** — a staff member's display name, avatar and email signature, keyed
  by their account. *This table exists because the design promises human-readable names on
  outbound email and in the timeline, and accounts are opaque ids.* Without it, "Anna from
  Substrat" has no source.

**The conversation**

- **`conversation`** — contact, channel (widget or email), subject, state, assignee,
  snooze-until, priority, when it was first replied to, when resolved, what it merged into,
  timestamps.
- **`message`** — conversation, who wrote it and in what capacity (contact, agent,
  assistant, system), the body in text and HTML, **public or internal**, and the email
  headers that stitch it into an email thread.
- **`conversation_tag`** — free tags, the way every desk grows them.
- **`saved_reply`** — canned answers. Title, body, who wrote it.
- **`csat`** — one score and comment per conversation, once resolved.

**The widget**

- **`widget_session`** — a browser session: its conversation, its contact, the origin it
  was opened from, first and last seen. The session token is stored hashed, never in the
  clear.
- **`desk_settings`** — one row per desk: which origins may embed the widget, the identity-
  verification secret, the from-address, business hours, greeting.

**The knowledge base**

- **`kb_source`** — where articles come from: a docs index, a sitemap, a folder of
  markdown. URL, last ingested, status.
- **`kb_article`** — one document: source, URL, title, heading path, body, a content hash
  so a re-ingest that changed nothing writes nothing, and when it was ingested.
- **`kb_article_search`** — a full-text index over titles and bodies. Confirmed available
  in the local database engine; must be confirmed on the hosted one before we lean on it
  (section 9).

**The assistant and its cost**

- **`ai_turn`** — one assistant turn: conversation, the message it produced, model, input
  and output tokens, which articles it cited, how confident it was, what happened next,
  and the ledger entry it recorded. *This is the side table hanging off the metering
  entry* — the ledger counts tokens and stays ignorant of support desks, which is exactly
  what its documentation asks for.
- **`usage_rate`** — meter key to unit price, with an effective date. Ours, because prices
  are our vocabulary and the ledger has no opinion about money.

**Notifications**

- **`notification`** — who should be told, about what conversation, what kind, read or not.

---

## 8. The scenario the test will replay

One story, end to end, then the attacks.

**The happy path**

1. A stranger on substrat.net opens the widget and asks *"how do I run a migration against
   a scope that's already live?"* — a conversation opens, anonymous, tied to this browser
   session.
2. The assistant searches the Substrat docs, finds three pages, and answers with citations.
   The turn's tokens land in the ledger with the turn id as the key.
3. **The same turn is replayed** (a retry, exactly as a flaky network would produce). The
   ledger returns the existing entry. No second charge. This is one assertion and it is
   the whole reason we are using the metering engine.
4. The customer is not satisfied and emails `support@substrat.net` from the address the
   host page had already vouched for. The connector stitches it onto the same contact, and
   the conversation now spans two channels.
5. An agent picks it up, leaves an **internal** note, sends a **public** reply, and
   resolves it. The customer's copy contains the reply and not the note.
6. The customer replies once more. The conversation **reopens**, in place, with history.
7. The month closes. The desk admin opens the cost view and sees frozen per-meter lines and
   a priced total.

**The attacks — each one must fail**

| The attempt | Why it must fail |
|---|---|
| The agent opens the cost view | Only the desk admin sees the money |
| **Kestrel's** assistant sends a public reply | That desk never granted it — the draft exists, nothing left the building |
| **Substrat's** assistant sends a public reply | Allowed. Same code, different grant. The pair is the demonstration |
| Contact A opens contact B's conversation | Customers see their own and nothing else |
| An anonymous visitor asks for the contact's *other* conversations | The bottom rung sees one conversation, not a history |
| A forged identity-verification signature | Fails the signature check before a principal exists |
| The widget loads from an origin not on the desk's allowlist | Refused at the door |
| A Kestrel admin reads a Substrat conversation | Nothing. Different database |
| A customer requests the internal notes on their own conversation | Their own conversation, still not their notes |

The last four are the ones worth putting on a screen in front of a person.

---

## 9. Open decisions

Each with a recommendation, so this is a choice and not a specification exercise.

1. ~~**How an anonymous visitor becomes a principal.**~~ **Settled, and the answer was
   that they do not.** This was the riskiest open question in the first draft: an account
   per visitor needs somebody with authority to grant it, needs reaping, and leaves
   tombstones behind when revoked. None of that is necessary — a session token confines a
   visitor to one conversation, and the widget's operations cannot be pointed at another
   one because they take no conversation id (section 4). What remains is the surface, the
   rate limit, and the reaper for abandoned *conversations* — which is a retention policy,
   not an access-control problem.
2. **The widget's surface and CORS.** *Recommended: a second `widget` surface of the same
   vertical on its own hostname, with the embedding-origin allowlist in desk settings and
   CORS support added to the vertical host.* Routing already supports this; the anonymous
   principal and the CORS layer do not exist. Platform work, sequenced before the widget.
3. **How email arrives.** *Recommended: the Resend inbound webhook*, which forces the
   webhook-ingress work — signature verification and replay protection — that has been
   scoped and never built. The alternative is Cloudflare Email Routing, which is a
   different shape (an adapter, not a connector) and does not obviously reach a vertical
   running in a dispatch namespace.
4. **How the knowledge base is searched.** *Recommended: full-text search first, in the
   desk's own database, with embeddings behind the same interface later.* Full-text is
   confirmed present locally and must be confirmed on the hosted database engine before we
   commit; if it is absent, embeddings via the LLM connector become the v1 path and the
   estimate moves.
5. **What the knowledge base ingests.** *Recommended: the docs' machine-readable index and
   the source markdown — not a crawl of the rendered site.* Substrat already emits such an
   index and gates it, so tenant #1's knowledge base is nearly free. A generic tenant gets
   a sitemap crawler later.
6. **Billing, if it comes back.** Requires an additive fourth consumed event on the
   invoicing engine. Recorded in section 5 so the deferral has a shape.
7. **Authentication.** *Recommended: wire the identity seam from the start*, with the
   local development issuer, so signing in locally is the same round trip as in
   production. The desk has genuine logged-in users on day one — staff — so there is no
   version of this that stays a development header.
8. **Where it runs.** *Recommended: local first*, then a real desk on substrat.net once
   decisions 1–3 have landed. Dogfooding is the point, but it is the reward for the
   platform work, not a shortcut past it.

---

## 10. Out of scope

Deliberately not in this build, so the review is about a bounded thing: service-level
timers and escalation policies; phone, SMS and social channels; multilingual answering;
routing rules beyond assignment and round-robin; satisfaction analytics beyond storing the
score; knowledge bases that live in Notion or Confluence; a public help centre; billing
(section 5); and any marketplace listing.

---

## Review questions for the human

1. **The assistant's authority as a grant** (section 4) is the design's central bet: the
   difference between a desk where the AI talks to customers and one where it cannot is a
   permission on its account, not a setting. Is that the behaviour you want at the desk-
   admin's fingertips — and are you comfortable that revoking it mid-conversation stops the
   assistant mid-sentence?
2. **The three trust rungs** (section 4) put real weight on a signature the customer's own
   website computes. A company that leaks that secret exposes its customers' support
   history to each other. Is the shared-secret model right, or should the middle rung
   require a short-lived signed token instead of a stable signature?
3. **Sections 1 and 3 disagree about ambition on purpose.** The widget and inbound email
   both need platform capabilities that do not exist yet. Do you want ticket0 scoped to
   what runs today — email-less, widget-less, an inbox with an assistant and a knowledge
   base — and the two platform pieces sequenced as their own work, or is this demo the
   thing that justifies building them?
