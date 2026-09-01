# ticket0 (support desk)

`demos/ticket0` — an AI-assisted support desk: a chat widget a company embeds on its own site
with one `<script>` tag, an inbox, and an assistant that answers from that company's
documentation and is honest about what it cost. Tenant one is Substrat itself — the bubble on
[Ask the docs](/guide/support) is this demo, answering out of this site's `llms-full.txt`.

## Overview

ticket0 is the demo with a **public surface**. Every other vertical begins at a login; this one
begins with a stranger in a chat bubble on somebody else's page. It proves:

- **An unauthenticated surface on a vertical, without a hole in it.** Three widget routes —
  open a session, post a message, read the thread — run with no principal. A visitor is confined
  by a **session token** rather than a login, the request's `Origin` header is checked against
  the desk's allowlist *in middleware, before the handler*, and the one permission the surface
  needs (`conversation:widget`) is held by the widget's service principal alone. An embedding
  site can vouch for a visitor with `HMAC-SHA256(desk secret, data-user)` from its own backend;
  the script never sees the secret.
- **The assistant is a member of staff, not a feature.** It has a principal, a role and a name
  on its replies. `assistant` may draft and never post; `assistant-autonomous` may reply to the
  customer. Which one a desk grants is the desk admin's decision, and the supervised desk in the
  demo (Kestrel) shows the assistant declining to have the last word.
- **Honest cost, through [`metering`](/engines/metering/).** Every assistant turn records what
  it consumed in an append-only ledger keyed by turn id, so a retried turn cannot double-count, a
  correction is a compensating entry, and a closed period is frozen evidence. `usage:read` is the
  desk admin's alone: sign in as Markus and the money is on the screen; sign in as Anna and the
  same screen has none — a permission, not a flag.
- **The public/internal flag is load-bearing.** A message is either public (the customer sees it)
  or internal (only staff do); nothing reaches `resolved` without a public reply, a customer's
  reply *reopens* the same thread, and a merged conversation keeps its history. `closed` is the
  one way out that asks nothing — a thread nobody will ever answer is unresolvable, so requiring
  a resolve on the way to closed would strand it in the inbox for good. Only resolving stamps
  `resolved_at`, and the reports count that stamp, so an emptied inbox moves no number. The
  customer-facing read is written once and strips author ids.
- **Failure is never silent.** A turn that could not answer carries its reason, the
  conversation draws it as a card, and *Settings → Assistant* says which model this install
  answers with and lists the newest failures.

## At a glance

| | |
|---|---|
| **Package** | `@substrat-run/demo-ticket0` |
| **Engines composed** | [`metering`](/engines/metering/) — the concept also names `invites`, but staff join through the platform's own identity invites, so no invites engine is composed |
| **Own tables** | `ticket0_conversations` · `ticket0_messages` · `ticket0_contacts` · `ticket0_conversation_tags` · `ticket0_csat` · `ticket0_ai_turns` · `ticket0_usage_rates` · `ticket0_kb_sources` · `ticket0_kb_articles` · `ticket0_saved_replies` · `ticket0_agent_profiles` · `ticket0_notifications` · `ticket0_desk_settings` · `ticket0_widget_sessions` · `ticket0_widget_openings` |
| **Roles** | `desk-admin` · `agent` · `customer` — plus four service roles: `assistant`, `assistant-autonomous`, `relay` (email in and out) and `widget`; a customer reaches their own conversation through an entity-narrowed `conversation:read-own` |
| **Permission surface** | [`PERMISSIONS.md`](https://github.com/substrat-run/substrat/blob/main/demos/ticket0/PERMISSIONS.md) — 19 keys, 2 modules, 7 roles |
| **Auth** | [OIDC only](/concepts/identity) — no credential store; the dev issuer lists names instead of asking for a password |
| **Apps** | issuer (`:8879`) · API and the public widget surface (`:8874`) · the desk — inbox, settings, portal (`:5281`) · a stand-in customer site with the widget on it (`:5279`) |
| **Status** | Working — hosted at `ticket0.substrat.net`, serving the widget on [/guide/support](/guide/support) |

## The cast & what's denied

| Who | Holds | Cannot |
|---|---|---|
| **Markus** | `desk-admin`, Substrat's desk | — (settings, widget origins, the knowledge base, **the cost**) |
| **Anna** | `agent`, Substrat's desk | **see usage or cost**, configure the desk, manage the knowledge base, or merge conversations |
| **Priya** | `customer` — entity-narrowed `conversation:read-own` | see anyone else's conversation, or the internal notes on her own |
| *(a visitor in the bubble)* | a session token, no principal | reach any conversation but the one the token names; embed from an origin the desk did not allow |
| **Dana** / **Omar** | `desk-admin` / `agent` of **Kestrel Analytics** | anything of Substrat's — a different desk, and guessing a conversation id reaches nothing |

Kestrel exists to be attacked, and its assistant is the supervised one — it drafts, a human
sends. Sign in as Dana or Omar to find those drafts waiting in the inbox.

## Run it

```bash
pnpm --filter @substrat-run/demo-ticket0 dev
# issuer  http://localhost:8879
# API     http://localhost:8874   (also serves widget.js and the public widget routes)
# desk    http://localhost:5281   (Markus sees the cost, Anna does not)
# site    http://localhost:5279   (a stand-in customer page with the widget on it)
```

Embedding is the one tag the README documents — `<script src="https://desk.example/widget.js"
data-user="…" data-signature="…">` — and `TICKET0_WIDGET=1 pnpm --filter @substrat-run/docs dev`
puts the widget on every page of this site locally. Tests: `test/scenario.test.ts` (the
lifecycle, the public/internal split, merges, and every denial above) and
`test/assistant.test.ts` (drafting, autonomous replies, the metered turn and the recorded
failure).

## Deliberately out of scope

Real-time delivery — replies arrive by polling, and `widget.js` says so; the right answer is a
WebSocket on the scope's own Durable Object, which is platform work. From the concept: SLA
timers and escalation policies, phone/SMS/social channels, multilingual answering, routing
beyond assignment and round-robin, satisfaction analytics beyond storing the score, knowledge
bases in Notion or Confluence, a public help centre, billing, and any marketplace listing.
