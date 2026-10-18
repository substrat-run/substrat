---
"@substrat-run/model-view": minor
"@substrat-run/cli": minor
"create-substrat": minor
---

`spec/concept.md` keeps its roles, entity model and processes true to the code. Three regions between `<!-- substrat:roles -->`, `<!-- substrat:entities -->` and `<!-- substrat:processes -->` markers are rendered from `PERMISSIONS.md` and `model.json`: a roles and permissions table, a Mermaid `erDiagram`, and a `stateDiagram-v2` per declared lifecycle. `substrat concept sync [dir]` rewrites them (the same input gives byte-identical output; `--check` writes nothing and exits 1 when the file is stale), and `@substrat-run/model-view` exports the pure `syncConcept` behind it. A new project ships a `spec/concept.md` with the markers and a decisions-log section, and its playbook tells the agent to sync after every model or permission change and to write the decisions-log entry itself.
