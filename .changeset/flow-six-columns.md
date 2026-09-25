---
"@substrat-run/dashboard-web": minor
---

Processes › Flow now draws an app as six columns, left to right: triggers, modules, events, consumers, connections and outbound hosts. Each node shows its health as a coloured edge and a mark (✓ healthy, ▲ degraded, ● failing, dashed for declared but unused), and clicking one highlights everything that feeds it and everything it feeds. Dead letters, operation health, connection usage and declared-vs-observed findings sit beside the map, and each row links to the event explorer or the app's integrations.
