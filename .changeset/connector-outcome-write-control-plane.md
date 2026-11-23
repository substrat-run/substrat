---
"@substrat-run/control-plane": patch
---

The scheduled pass waits for its sweep-run and ops-failure writes before it returns, so the last connector sweep's outcome is no longer dropped and a healthy connection is no longer backed off as if its sweep had crashed.
