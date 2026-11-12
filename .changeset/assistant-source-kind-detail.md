---
'@substrat-run/contracts': minor
'@substrat-run/elements': minor
---

- contracts: the assistant stream's `source` event takes an optional `kind` (an open string, so a new kind never makes an older reader drop the citation) and `detail` (a short line saying where the source lives).
- elements: `<sub-assistant>` draws an icon for a source whose `kind` is in `ASSISTANT_SOURCE_KINDS` and its `detail` quietly after the title, with new parts `source-icon` and `source-detail`; `AssistantCitation` carries both.
