---
"@substrat-run/cli": minor
"@substrat-run/model-view": minor
"create-substrat": patch
---

`substrat plan [dir]` shows the concept delta a design gate approves, computed from `model.json`, `openapi.json` and `PERMISSIONS.md` against the merge-base: the entities added, changed and removed with the model as a Mermaid diagram before and after, lifecycle changes with the operation that triggers each transition, the permission-diff table (key, description, roles before and after), the spec-version impact from the same classifier `substrat changeset` uses, and the decisions-log entry approving it would write. `--json` prints the delta for an agent. Nothing is written until a person approves: `substrat plan --approve <digest> --by <name> --why <reason>` appends the entry to the Decisions log of `spec/concept.md` and re-syncs it, and refuses a digest that no longer matches the delta, so an approval records what was shown. `@substrat-run/model-view` exports `entityDiagram` and `lifecycleDiagram`, the renderers behind the concept document's generated regions. The scaffold's playbook shows the concept delta at its design gate for a change to an existing model.
