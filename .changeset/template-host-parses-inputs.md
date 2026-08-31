---
'create-substrat': patch
---

The scaffold now hands the host its declared operation inputs. Every `npm create substrat`
project starts with `operationInputs` on its `ModuleRegistration`, so a malformed call is
refused at the scope door — before the guards, before the permission check, on every path
in — instead of reaching a handler that reads the field raw. The template's operations
declare their input as a Zod object and take their handler's input type from it, so the
schema and the type are one description rather than two that can drift; the timeline
operation's hand-parse is gone, because the host already did it.
