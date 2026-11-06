---
"@substrat-run/contracts": minor
"@substrat-run/builder": minor
"@substrat-run/builder-generator": minor
---

Each builder turn now records what is needed to compare it with another: the model that actually ran, a digest of its skills, the toolchain, cached tokens, steps, passes, generator and gate time, files written, and every tool's calls, failures and time. Generators emit a `tool-result` event, and a long gate output keeps its head and tail in the record instead of being lost.
