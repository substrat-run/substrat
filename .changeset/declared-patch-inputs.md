---
"@substrat-run/contracts": minor
"@substrat-run/demo-todo": patch
"@substrat-run/demo-ticket0": patch
---

Refuse PATCH operations with required body fields or Zod defaults unless the declaration gives a nonempty `patchException` reason. The check also applies when a composed engine operation is bound to PATCH. A downstream vertical can make the body fields optional without defaults, route a full replacement as PUT, or declare and review a reasoned exception.
