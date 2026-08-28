---
'@substrat-run/engine-workorder': minor
---

`assignWorkOrder`, `startWorkOrder`, `reportTime` and `reportMaterial` are exported in-scope functions (#975). They used to live inline in the `workorder/assign`, `workorder/start`, `workorder/report-time` and `workorder/report-material` handlers, so a vertical could not assign, start or report inside its own transaction without forking the engine. The four operations are now thin bindings — the permission check plus one call — and their behaviour and event payloads are unchanged. Each function's input is the schema its operation declares (also exported: `assignWorkOrderInput`, `startWorkOrderInput`, `reportTimeInput`, `reportMaterialInput`), parsed on the way in.
