---
'@substrat-run/demo-ticket0': minor
---

ticket0: the assistant's failures are visible in the desk, with their reason.

- A failed turn now carries `error` — why it failed, in the words of whatever threw
  (migration `0002-add-ticket0_ai_turns-error`). `record-answer` accepts it (additive,
  optional) and `list-turns` returns it. The conversation view draws a failed turn as a
  "could not answer" card with the reason, in place of an internal note that said only
  that it had given up.
- `answerConversation` records a failed turn for an index that refused, not just for a
  model that threw; the reason used to leave with the exception.
- New `ticket0/record-assistant-failure` (`conversation:widget`, entity-narrowed): when the
  assistant itself cannot act — no service principal, no role, its first call refused — the
  host records the failure through the widget, the principal that just accepted the
  message. Both hosts do this from their `catch`; the worker's used to be bare and silent.
- New `ticket0/assistant-health` (`desk:configure`) and `GET /api/assistant/status`, behind
  Settings → Assistant: which model this install would answer with (and a plain warning
  when it is `offline/extractive` because no `CF_ACCOUNT_ID`/`CF_AI_TOKEN` is set), the
  last day's turn and failure counts, and the newest failures linked to their conversations.
