# Design prompt — ticket0

Paste everything below the line into Claude Design. It is written to stand alone: it
assumes no knowledge of this repo, and every screen and field it names exists in
[`model.ts`](model.ts), so what comes back can actually be built.

---

Design **ticket0**, an AI-assisted support desk. Four surfaces, seventeen artboards. Read
the whole brief before starting — the constraints in "Three things that decide whether this
design is any good" are not styling notes, they are the product.

## What the product is

A company drops one script tag on its website and gets a support desk. Customers ask
questions in a chat widget or by emailing `support@theircompany.com`. An AI assistant reads
the company's own documentation and answers — or drafts an answer for a human to send,
depending on how much rope that company gave it. Support staff work the inbox. The desk
admin sees what the AI cost.

The name is the promise: zero open tickets, mostly because most of them never needed a
human.

**The audience is developer-facing.** The first customer is a platform company whose docs
are the knowledge base. Think Linear, Height, or Raycast rather than Zendesk or Freshdesk:
dense, calm, keyboard-first, no gradients, no illustration, no chrome that apologises for
itself. Design light and dark; neither is the afterthought.

## The cast, and what each one may see

| Who | Works in | Sees |
|---|---|---|
| **Desk admin** | the inbox + settings | everything, **including cost** |
| **Support agent** | the inbox | every conversation in the desk, **never any cost figure** |
| **The assistant** | — (it has an account and a name, "Assistant") | it writes; it appears in threads like staff |
| **Customer** | the widget, or a portal if they sign in | only their own conversations, only public messages |

## Three things that decide whether this design is any good

**1. Public versus internal must be impossible to confuse.** Every message in a
conversation is either *public* (the customer receives it as an email or sees it in the
widget) or *internal* (only staff ever see it). Getting this wrong emails a colleague's
private note to a customer. A tint difference is not enough. The composer needs to make the
current mode unmissable *while you are typing*, not only after you send — someone who
glances away mid-sentence must be able to look back and know. Solve this properly; it is
the single most consequential thing on the screen.

**2. An agent must never see a cost figure.** Not in the conversation rail, not in a
tooltip, not greyed out with a lock icon. The screen simply does not have it. That means
the conversation view has two variants — admin and agent — and the difference has to look
deliberate rather than like something failed to load.

**3. The assistant is staff, not chrome.** It has a name and appears in the thread the way
a colleague does. Do not wrap it in robot styling, sparkles, or a gradient. What *does*
deserve visible treatment is its **draft state**: in a supervised desk the assistant writes
an answer that has not been sent, and a human decides. That card — draft, citations,
confidence, Send / Edit / Discard — is the most interesting object in the product. In a
desk where the assistant is trusted, the same answer is simply already sent and appears as
a normal message. **Same screen, two states.**

## The surfaces

### A. The inbox — staff (8 artboards)

1. **Inbox list.** Conversations, most recently active first. Each row: contact name (or
   "Anonymous visitor"), subject, a preview of the last message, channel (widget or email),
   state, assignee avatar, priority, relative time. Filters across the top: state, assignee,
   channel, priority. Show a count. Design the empty state and a 400-row state.
2. **Conversation — agent view.** The thread, the composer, and a right rail with the
   contact, the channel, tags, and assignment. No cost anywhere.
3. **Conversation — admin view.** The same screen with the cost of this conversation
   present in the rail. Make the two artboards comparable side by side.
4. **The assistant's draft, awaiting a human.** The card described above, sitting in the
   thread where it was written. It cites documentation pages — show the citations as
   something a human can actually check before sending, not as decoration.
5. **The assistant's answer, already sent.** The autonomous desk. Same conversation,
   different state.
6. **Composer, internal mode.** A note being written. See constraint 1.
7. **Saved replies.** Picking a canned answer into the composer.
8. **A resolved conversation that the customer reopened.** Resolution is not the end here —
   a customer who replies puts it back in the queue, in the same thread with its history.
   This transition needs to read clearly in the timeline.

States a conversation moves through: `new → open → snoozed → resolved → closed`, plus
reopening from `resolved` back to `open`. Design the badges for all five.

### B. Desk settings — admin (4 artboards)

9. **Desk settings.** From-address, greeting, business hours, and the list of website
   origins allowed to embed the widget.
10. **Identity verification.** The desk holds a secret; the customer's own web server uses
    it to vouch for a signed-in user without them logging into support (this is how
    Intercom's `user_hash` works). Rotating the secret shows it **once** and invalidates
    every signature the customer's site is currently producing. Design that moment: it is a
    dangerous action with a value you can never see again.
11. **Knowledge base.** The documentation sources the assistant reads. Each: label, URL,
    kind, when it last ingested, status (idle / ingesting / failed), and a re-read action.
    Show a failed source with its error.
12. **Usage and cost.** The money screen, admin only. Per-meter lines (input tokens, output
    tokens) with quantity, unit price and amount; a month total; a "close the month" action
    that freezes the period permanently. Prices are per-token and tiny — `0.000003` — so the
    numbers need a treatment that stays legible without lying about precision.

### C. The customer portal — signed in (2 artboards)

13. **My conversations.** Short list, no chrome, calm.
14. **One conversation, plus rating it.** Public messages only — the customer must never
    glimpse an internal note. A satisfaction rating appears once the conversation is
    resolved.

### D. The chat widget — the embedded box (3 artboards)

This is the piece most people will see, and it lives on **someone else's website**, so it
cannot assume anything about the page around it.

15. **Launcher.** The closed state: a bubble in the corner, with and without an unread
    indicator. Show it against a plausible host page so the surrounding context is visible.
16. **Open, mid-conversation.** Greeting, message thread, composer. Include the assistant
    answering with a citation to a documentation page, and a "did this help?" moment that
    can route to a human. Design the "waiting for an answer" state.
17. **The three rungs of who the visitor is.** The same widget in three conditions, because
    what it may show differs:
    - **Anonymous** — a stranger who just opened the bubble. They have no account and never
      get one. They see the single conversation from this browser session, and nothing else,
      ever.
    - **Verified** — the host site's server vouched for them, so the widget knows who they
      are with no login. They see their history.
    - **Signed in** — a real login, with a link across to the portal.

    Make the distinction *legible without being alarming*. A visitor should be able to tell
    whether the desk knows who they are; they should not feel audited.

## Vocabulary to use exactly

conversation (not "ticket" — the ticket is a view of a conversation once it needs work),
message, public / internal, contact, assistant, desk, knowledge base, source, article,
snooze, resolve, close, reopen, merge.

## Deliberately out of scope

Service-level timers and escalation policies; phone, SMS and social channels; multilingual
answering; routing rules; a public help centre; analytics dashboards; billing and invoices.
If a screen seems to want one of these, leave the space and move on.

## What I want back

Seventeen artboards on one canvas, grouped by surface, light theme with the widget group
also shown in dark. Real content throughout — real support questions about deploying
software, real documentation titles, real names — never "Lorem ipsum" and never
"Customer 1". The empty states and the failure states matter as much as the happy ones; a
design that only shows the good day is a design that has not been finished.
