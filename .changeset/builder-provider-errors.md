---
"@substrat-run/builder": patch
---

Provider errors name their real failure class (quota exhausted ≠ invalid key ≠
rate limit ≠ wrong region), keep the provider's own message, and say what to do
next — shared worker-safe explainer for the hosted DO and the local CLI.
