---
"@substrat-run/control-plane-api": patch
---

The tenant log view labels a 501 as `capability absent` at `info` level instead of rendering it as a red error row, and an error read no longer selects 501 invocations. A 501 is a vertical saying a version does not declare a capability, which the failure record already treats as a refusal rather than a failure (#1345).
