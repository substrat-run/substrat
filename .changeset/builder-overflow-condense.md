---
'@substrat-run/builder-generator': minor
---

feat(builder-generator): context-overflow recovery — condense and resume (#663 row 5)

A provider context-overflow error mid-turn no longer kills the turn: the loop
drops old tool payloads from the transcript (write bodies, tool outputs —
tool_call/tool_result pairing preserved), keeps the recent working set
verbatim, and re-issues the failed request. Deterministic and reactive-only —
no LLM summarizer, nothing to overflow, no cache forfeited until the provider
has already rejected the transcript. Escalation-capped: gentle pass → drop
everything droppable → fatal with the provider's message. Qwen temperature
0.55 and OpenAI promptCacheKey/store:false defaults ride the same release.
