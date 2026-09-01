---
status: historical
layer: plan
description: Feature survey of the support-desk market (Zendesk, Freshdesk, Intercom, Help Scout), surveyed 2026-09-02.
---

# The support-desk market — feature survey

Status: v1.0 · Surveyed: 2026-09-02 · Source: each vendor's own pricing page and help
centre, supplemented by third-party pricing trackers **only** where the vendor no longer
publishes a tier (noted inline).

> **Naming, unlike [the FSM survey](fsm-vendor-feature-survey.md).** That one is anonymized
> because the master plan discusses that vendor as a competitor and an acquisition
> question. These four are ordinary public products that [ticket0's own
> concept](../../demos/ticket0/spec/concept.md) and README already name — the identity
> verification scheme is borrowed from Intercom by name — so there is nothing to protect
> and anonymizing would only make the document unreadable.
>
> **Shelf life.** Prices and tier boundaries are the most volatile facts here and they move
> every few quarters. `research/` is never revised: when this is stale, write a v2 beside
> it rather than editing this one.
>
> **What this document is for.** [#1089](https://github.com/substrat-run/substrat/issues/1089)
> asks whether ticket0 means to be a credible replacement for these products or a demo that
> proves the platform, and lists our gaps. It has no evidence attached — it says what we
> lack, never what they ship or at what tier. This is that evidence. It does not answer the
> question; §5 sharpens it.

## 1. The four, and what each really is

| Product | What it really is | Who it is sold to |
|---|---|---|
| **Zendesk** | The ticketing system the category is named after. Email-first, channel-agnostic, deep configuration, and an admin surface that assumes a support *operation* with roles and process | Mid-market and enterprise support orgs |
| **Freshdesk** (with **Freshchat**) | Zendesk's shape at a lower price, split across two products — the desk (tickets, KB) and the messenger (chat, campaigns, journeys) — and increasingly sold bundled as "Freshdesk Omni" | SMB to mid-market |
| **Intercom** | A messenger first and a desk second. Its other half has always been *initiating* conversations — leads, campaigns, tours, banners — and Fin has made it an AI-answering company | Product-led SaaS |
| **Help Scout** | The deliberately small one: shared inbox, Docs, one embeddable Beacon, no ticket vocabulary shown to the customer. Priced per *contact*, not per seat | Small teams who find Zendesk oppressive |

ticket0's concept aims at Help Scout's customer ("a support desk sold to small software
companies") with Intercom's mechanisms (the widget, the identity ladder, the assistant as
staff). That combination is worth noticing: **nobody in this table occupies it.** Help Scout
is cheap and shallow on the widget; Intercom is deep on the widget and priced for
product-led SaaS.

## 2. The commercial shape

Two layers everywhere: a **per-seat subscription** for the desk, plus **metered AI** billed
on outcomes. The second layer is new and is the industry's live pricing question.

| Product | Seats (list, annual) | AI, metered separately |
|---|---|---|
| **Zendesk** | Support Team $19; Suite Team $55; Suite Professional $115 per agent/month. Enterprise + Copilot is quote-only. Suite Growth is no longer on the public page; trackers cite $79–89 | Automated resolutions metered by outcome rather than bundled into the seat |
| **Intercom** | Essential $19; Advanced $85; Expert $132 per seat/month. Free "Lite" seats for internal collaborators on Advanced/Expert | Fin at **$0.99 per resolution** — counted when the customer confirms the answer resolved it, or does not ask again after it |
| **Freshdesk** | Growth / Pro / Enterprise | Freddy AI Agent **sessions**: 500 free once per account, then **$49 per 100**. A session is one end-user interaction; for email it is a 72-hour window, however many replies it contains |
| **Help Scout** | **Contact-based**: many conversations with the same person count as one contact. Beacon is on every plan, including free | AI Resolutions and AI Drafts priced as their own lines |

Three observations that matter more than the numbers:

1. **The unit of AI billing is an outcome, never a token.** Resolution (Intercom, Zendesk,
   Help Scout) or session (Freshdesk). No one in this market bills the customer for model
   consumption, because no buyer can forecast it.
2. **Seats are the floor, not the price.** The metered layer is where the margin moved.
3. **Help Scout's contact-based billing is the one genuine divergence** — it prices the
   size of your customer base rather than the size of your team, which is a different bet
   about who the software is for.

## 3. Feature by feature, against what ticket0 has today

"ticket0 today" is read from `demos/ticket0/spec/model.ts` (60 declared operations) and
`PERMISSIONS.md` (19 permission keys, four of them from `engine-metering`; roles `agent`,
`assistant`, `assistant-autonomous`, `customer`, `desk-admin`) at the date above.

### 3.1 Intake — widget, pre-chat, identity

All four embed one script tag and all four collect identity as **structured fields before
the conversation**, not out of prose:

- **Zendesk** — the widget's contact form creates a ticket from an anonymous end user;
  custom fields can be collected before agent handoff. Anonymous submission is a setting
  ("anybody can submit tickets"), and an unverified one lands in a **suspended** queue with
  a verification email.
- **Freshchat** — a pre-chat form of typed fields (text, phone, email) each with a
  mandatory flag; it creates the contact and the ticket and hands the AI agent context.
- **Intercom** — "require an email before a conversation starts", plus a qualification step
  collecting up to four attributes. Its contact model is a lifecycle: visitor → lead → user.
- **Help Scout** — Beacon does contact form, chat, Docs search and AI in one widget on every
  plan; `Beacon Identify` syncs contact properties, and the hardened mode requires a secret
  key.

**ticket0 today:** three public widget routes with the `Origin` allowlist checked in
middleware, a session token rather than a login, and the HMAC identity ladder (anonymous →
vouched-for → signed-in) that is *better specified* than any of theirs. It has **no
pre-chat capture at all**: `contact.email` is null for every anonymous visitor, and there
is no field anywhere in the widget that would set it.

### 3.2 Proactive and outbound

- **Zendesk** — proactive messages require Suite Team or above (explicitly not Support
  Team), need a messaging widget, cap at 140 messages, and are **not sent to a customer who
  is already in an active conversation**.
- **Freshchat** — campaigns and a visual Journeys builder, with event triggers and
  segmentation, metered by campaign contacts.
- **Intercom** — the deepest: targeted messages to visitors, banners, tours, Series.
- **Help Scout** — proactive messages inside Beacon, the shallowest of the four.

**ticket0 today:** nothing. It only answers. Note what the tiering says: proactive is a
separately priced product with targeting infrastructure behind it at all four — which is
strong external support for #1089's judgement that this is "a genuine fork in what the
product is", not a widget setting.

### 3.3 The help centre

Zendesk Guide, Freshdesk Solutions, Intercom Articles, Help Scout Docs — all four publish a
customer-facing knowledge base, and Zendesk tiers it by *count* (one help centre on Team,
five on Professional). Authoring drags a second feature behind it: an **approval workflow**
(draft → review → approved → published) is Professional-and-above at Zendesk and
**Enterprise-only** at Freshdesk. Multilingual articles are Pro-and-above at Freshdesk.

**ticket0 today:** the knowledge base is *ingest-only* — `add-kb-source`, `ingest-kb-source`,
`record-kb-articles`, `search-kb` over `llms-txt`, sitemap and markdown sources. It feeds
the assistant and nothing else; you cannot author an article and there is nothing to
publish. #1089 calls this the closest adjacency ticket0 has, and it is right that the store
is already there — but the survey shows it is **two** features, not one, and the second is
what the incumbents charge for.

### 3.4 Automation, SLA, business hours, routing

Zendesk is the reference: triggers and automations evaluate ticket data and act; SLA
policies set response and resolution targets per priority; business hours arrive at Suite
Growth / Support Professional (one schedule below Enterprise, several on it); skills-based
routing is Professional and above. Freshdesk mirrors this shape a tier lower.

**ticket0 today:** `assign`, `snooze`, `wake`, `wake-snoozed`, `set-priority`,
`tag-conversation` — the *verbs*, with no rule engine choosing when to call them, and no
timer that fires. This is #1082 and #1083. The survey's contribution is the tier: none of
this is entry-level anywhere. It is what you sell at tier two.

### 3.5 Tenant-shaped data — custom fields, forms, brands

Every one of the four lets a tenant define its own fields on a contact and a ticket, and
Zendesk and Freshdesk put ticket forms on top of that so intake can be reshaped without a
code change. Zendesk multi-brand and Freshdesk products give a tenant several front doors
over one desk.

**ticket0 today:** every desk gets exactly the columns ticket0 shipped, one `deskSettings`
row, one from-address, one origin allowlist. This is the gap in the list that is **not the
vertical's to close** — a tenant-defined field on a declared entity is precisely what
`spec/model.ts` does not express — and it is the most interesting finding in this document
for the platform rather than the demo.

### 3.6 The AI layer

All four now ship an AI agent that answers from the knowledge base, all four bill it by
outcome (§2), and all four expose some notion of confidence or handover to a human.

**ticket0 today:** the assistant is a **member of staff with a principal, a role and a name
on its replies**, and the difference between drafting and replying is a permission
(`assistant` vs `assistant-autonomous`) rather than a setting. No product in this table
models it that way; they all model the bot as configuration. Cost is recorded per turn in
`engine-metering`'s append-only ledger, keyed by turn id so a retry cannot double-count,
and `usage-summary` / `desk-metrics` read it back.

So ticket0 measures **tokens consumed**; the market prices **outcomes achieved**. The
metering engine could express a resolution meter tomorrow — what is missing is the
*signal*: nothing in the desk records "this conversation was resolved by the assistant
without a human". CSAT is stored; a resolution outcome is not.

### 3.7 Privacy, retention, erasure

This is the axis where the market is weakest and it is worth stating plainly. Zendesk
supports GDPR on every plan, but **retention policies, data masking, automatic PII
redaction, access logs and end-user deletion schedules are the Advanced Data Privacy and
Protection add-on, sold on Suite Enterprise and above**. Erasure below that tier is a manual
act: redact the fields, then delete the user.

**ticket0 today:** erasability is a *declared property of the model*, at no tier — `contact`
declares `email` and `display_name` erasable, `message` declares `body_text` and
`body_html`, `agentProfile` and the CSAT comment declare theirs — and because an event may
not carry an erasable field, the kernel's own event spine cannot become a second copy of
the text you erased. That is a structural guarantee, not a feature, and nobody in this
table has it at any price.

### 3.8 Reporting

Zendesk Explore, Freshdesk analytics, Intercom reports, Help Scout reports — response time,
resolution time, backlog, CSAT, and now deflection, all with per-tier depth limits.

**ticket0 today:** `desk-metrics`, `get-csat`, `usage-summary`, `assistant-health`. Thinner
than any of them, but no longer the hole #1085 described.

## 4. Table stakes, versus what everyone charges for

The single most useful output of this survey, for a decision about scope:

| Table stakes — present at the entry tier everywhere | Sold at tier two or above |
|---|---|
| Embedded widget with structured pre-chat capture | Proactive messages and campaigns |
| Anonymous intake **with** an abuse story (verification, suspended queue) | SLA policies, business hours, skills-based routing |
| A published, searchable help centre | KB approval workflow; multilingual articles; several help centres |
| Attachments on a conversation | Tenant-defined custom fields, ticket forms, multi-brand |
| Contact + conversation search | Retention policies, PII redaction, deletion schedules (Zendesk: Enterprise add-on) |
| Canned/saved replies | Advanced reporting, sandbox, audit logs, SSO |
| CSAT collection | Outbound webhooks and app platforms |

Read against ticket0's open issues, the entry-tier column is where the real deficits are:
attachments (#1080), abuse handling (#1088), the help centre (#1089), and pre-chat capture
(unfiled at the time of writing). Most of the rest of the gap list sits in the right-hand
column, which is a different and much less urgent kind of missing.

## 5. Implications for ticket0 (deltas against the current design)

1. **The pre-chat field is the cheapest table-stakes gap we have, and it is unfiled.** All
   four capture identity as typed fields before the conversation. Zendesk and Freshchat make
   it deterministic and mandatory; only Intercom makes it conditional on a bot. For anything
   whose *point* is the address — a waitlist, a lead — the deterministic shape is right.
2. **Anonymous intake without abuse machinery is the highest-risk gap, not the help
   centre.** Zendesk pairs open submission with a suspended queue and email verification
   because that pairing is forced. ticket0 has two public doors, no blocklist, no spam
   queue, no reaper (#1088) and no per-caller rate limit (#937) — and the widget is live on
   substrat.net today. Anything that drives more strangers at it (a proactive teaser, a
   landing-page CTA) should land after those, not before.
3. **Outcome metering is a product decision the platform already supports.** Switching from
   tokens-per-turn to something the market recognises needs no new engine — it needs the
   desk to record a resolution outcome. That is a small addition to the conversation model
   and it unlocks the only AI pricing shape any buyer in this market understands.
4. **Erasure is the one comparison claim we can make today without answering #1089.**
   Everything else on the public [ticket0 page](../../apps/docs/verticals/ticket0.md) is a
   platform-property argument; "every field that holds a person is declared erasable, on
   every plan, and the event spine cannot keep a copy" is a *competitive* argument that
   happens to also be a platform-property argument. Zendesk sells the weaker version as an
   Enterprise add-on.
5. **Custom fields are the platform's finding, not the vertical's.** Four products out of
   four let a tenant add a field; `spec/model.ts` cannot express one. This is the clearest
   case yet of a demo doing its job — it found a real limit in the model layer, and the
   answer belongs in `packages/model-emit` and the model concept, not in ticket0.
6. **The help centre is two features.** Authoring reuses the KB store we already have;
   publishing drags an approval workflow behind it, which both Zendesk and Freshdesk hold
   back for their top tiers. If we build it, build the authoring half and say plainly that
   review is a process, not a gate — or build the gate and charge for it.
7. **Proactive stays out, and now there is evidence.** Separately priced, separately
   metered, capped and targeted at all four. If we ever want the *effect* on our own site,
   the honest first step is a desk-level greeting teaser with Zendesk's suppression rule
   (never to someone already in an active conversation), not a campaign engine.
8. **Help Scout's contact-based billing deserves a look for Substrat itself.** Pricing the
   size of the customer base rather than the seat count is the one commercial idea in this
   survey we have not considered, and it sits oddly close to how the platform already meters
   scopes.
9. **#1089's own inventory has drifted.** It counts 44 operations where the model now
   declares 60, and lists conversation search as missing though #1142 shipped it. Whatever
   decision comes out of that issue should be recorded against this snapshot rather than its
   own bullet list.
