---
"@substrat-run/builder": patch
"@substrat-run/builder-web": patch
---

Auto model pairs: `<provider>:auto` resolves per phase — the pair's `fast` model runs interview turns, `strong` runs scaffold/iterate (`model-pairs.ts`, shared by both hosts so the pair the picker shows is the pair the turn loop runs). Declared pairs: qwen (`qwen3.6-flash` / `qwen3.8-max`, ids verified against the DashScope catalog) and anthropic (`claude-sonnet-5` / `claude-opus-5`). Pairs never cross a provider — the provider choice is the D-53 consent boundary. The local default is now `qwen:auto` (cheap testing era; weak-model runs double as adversarial QA for the mechanical guards); the hosted default is unchanged. The picker renders the pair as one selectable "auto" row naming both members, with every concrete model still selectable as an override.
