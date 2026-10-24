---
'@substrat-run/vertical-host': minor
---

The model host can run tools and conversations (#2283). `run()` now also takes `messages` (a conversation, ending with the user's turn) in place of `prompt`, and `tools`: each `{ description, input, execute }`, with `input` a Zod schema the model's arguments are parsed with. A tool call runs `execute` and hands its result back, up to `maxSteps` model calls (default 4, at most `MODEL_MAX_STEPS`, 8). The guard still runs once per request, and the usage line covers every step, priced per step. `run.steps` lists each model call with its tool calls and results. A request with both or neither of `prompt` and `messages`, or a `maxSteps` out of range, is refused before the guard. Existing calls with `prompt` are unchanged.
