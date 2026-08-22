---
'@substrat-run/docs': patch
---

The five pages that most needed a picture get one, and the engine state machines get drawn from the code.

Five diagrams, all on the twin machinery from the previous change, so every one of them reaches
`llms.txt` as markdown rather than as a pointer.

**The engine state machines are now emitted, not redrawn.** Five engine pages each drew their
machine in ASCII by hand, and two of the five had already drifted from the engine: booking's
picture showed neither `cancel` nor `no-show`, and protocol's omitted `voided` entirely. One
`<StateMachine engine="…" />` now derives the layout — a spine from the initial state, with
branches falling off it — from the machine itself. For `workorder`, `booking` and `invoicing`
that machine is read straight out of the emitted `model.json` that `lint:model --check` already
gates, so those three cannot drift again. `absence`, `protocol` and `invites` declare no
lifecycle yet, so theirs is transcribed in the same shape and **the page says so under the
figure**; when those engines adopt `defineLifecycles`, the entry swaps to `fromModel` and the
note goes away.

Four more, each replacing prose or a chart that was fighting its own layout:

- **`/concepts/permissions`** — the six-node mermaid `flowchart TD` becomes `<PermissionPipeline />`.
  Every node was a three-line paragraph, and dagre sizes boxes from label length, so a straight
  pipeline rendered as ragged blocks. The `lint:permissions` fork is now drawn as what it is — a
  review branch ending in a person, not a peer of `push`.
- **`/concepts/tenancy`** — `<TenancyTree />`. Tenancy is a tree and "one scope = one database" is
  a containment claim; both are shapes prose had to walk you through.
- **`/concepts/reads`** — `<ReadPaths />` draws the three paths as increasing distance from the
  scope boundary, because that distance *is* the staleness. Three peer boxes would have restated
  the table above it.
- **`/guide/environments-and-previews`** — `<InstanceResolution />`. The page's whole argument is
  that an instance is `(scope × version)` and exactly one link is mutable, so the binding is the
  only thing drawn in the accent.

`toTwin` and the `lint:llms --check` component assertion now match components with props, since
one component serving five pages is one component and five props.
