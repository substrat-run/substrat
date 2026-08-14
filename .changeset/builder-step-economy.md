---
"@substrat-run/builder-generator": minor
"@substrat-run/builder": patch
---

Step-level token economy. The tool loop re-sends the whole growing transcript on every step, so this is where the bill actually lives: on the Anthropic dialect a moving cache breakpoint (`prepareStep`) makes each step read the prior transcript from cache instead of re-billing it; on OpenAI-compatible dialects, stale tool payloads (an old `write_file` body superseded by a later write, an outdated `read_file` result, a re-run command's old log) are stubbed since there is no placeable cache there. The volatile workspace brief moves out of the pre-history prefix into the final user message so it stops invalidating the conversation cache; successful `run_command` output is capped at a 1.5k tail (failures keep 8k). Usage events now report the whole turn (`totalUsage`, not final-step-only — the old number under-reported multi-step turns) plus cache read/write splits, rendered per turn and per session in the studio UI.
