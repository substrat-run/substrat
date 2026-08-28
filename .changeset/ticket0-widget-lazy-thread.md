---
'@substrat-run/demo-ticket0': patch
---

fix(ticket0): opening the widget opens a session, not a conversation

Every `widget-start` used to open a conversation and mint a blank contact on the spot, so
the inbox showed an empty "Chat" for every curl, every crawler that ran the script, and
every visitor who clicked the bubble and left — the live desk on substrat.net held three
threads for one real chat. `spec/concept.md` had already promised the opposite: an
anonymous visitor is not a record, and the desk creates nothing on their behalf that
anybody has to clean up later.

- A new `widgetOpening` entity (`ticket0_widget_openings`) holds a session until its first
  message: token hash, origin, and — for a visitor the host site vouched for — the contact.
  The first `widget-post` opens the conversation (and the anonymous contact with it) and
  moves the row into `ticket0_widget_sessions` under the same id and token, so the widget
  holds the same session throughout and never learns the difference.
- `widget-thread` on an opening answers an empty page rather than a refusal: the widget
  polls before anything is said, and a 404 would make it discard the session.
- `widget-start` no longer returns `conversationId` (the widget never read it), and
  `ticket0.widget-session-started` is at `schemaVersion: 2`: it is about the opening, and
  `conversationId` left its payload.
- Its own table rather than a nullable `conversation_id`: the journal cannot relax a
  `NOT NULL` in place, and would have reported up-to-date over a live table that still
  refused NULLs. One appended migration, `CREATE TABLE` only.
- Scenario: a session open leaves the conversation and contact counts unchanged and reads
  an empty thread; the first message adds exactly one of each and the same session reads
  it back. The seed finds the customer's contact by external id instead of through a
  conversation that no longer exists at that point.
