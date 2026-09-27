---
"@substrat-run/console": patch
---

The promote dialog now shows what it asks you to acknowledge: the permission diff between the serving version and the one being promoted, and each new or edited migration's SQL. A version with no declared registry, or no stored SQL, says the diff cannot be shown rather than reading as no change, and the acknowledgement stays required either way.
