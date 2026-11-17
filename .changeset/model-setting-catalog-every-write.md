---
"@substrat-run/dashboard": patch
---

A model setting is now held to the platform's model catalog on every write, not only the Environment tab's: the install form picks it from the same catalog picker instead of a text field, and an app remembers which of its settings are models, so a write that reaches the app's environment another way is refused with the same "must be a listed model" problem (#1054).
