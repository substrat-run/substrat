---
'@substrat-run/docs': patch
---

The enforcement story gets its own page, and the AI-agents page gets its subject back

`guide/ai-agents.md` had grown two arguments inside one page: what makes the platform
*legible* to a coding agent, and what happens when that agent gets it wrong. The second one
was the more load-bearing of the two and the harder to find — a reader asking "what stops a
mistake" had to assemble the answer from five non-adjacent sections, plus the layer rules in
`reference/boundary-lint.md` and the honest caveats in `guide/what-substrat-lacks.md`.

**New: `guide/ai-guardrails.md` — Where AI mistakes stop.** The six guards a change passes
through, ordered as the sequence they actually fire in (compile → bound → derive → judge →
review → rehearse) rather than as a list of virtues, so the claim the page makes — that a
mistake surviving one guard meets the next — is carried by the structure and not just
asserted. It expands the five that need more than a paragraph: the R1–R6 layer rules and the
load-bearing exit code `2`, the three marks a generated file carries, the
code-from-model/tests-from-concept oracle, the two human checkpoints, and the preview fork.
It closes on what none of it claims, including the Durable-Object hole in the egress
allowlist.

**`guide/ai-agents.md` keeps the other half** — bring-your-own-model, the markdown docs
slice and `llms.txt`, the session-start hook, self-describing manifests, the local loop —
and hands off. Retained prose is unchanged; nothing is stated twice across the two pages.

**Two new figures, on the existing twin machinery.** `<BlastRadius />` draws the line with
what sits either side of it, and `<GuardPath />` draws the six stages. Both keep every string
in a sibling `.content.mts` and register an `alt()`, so they reach `llms.txt` as markdown
rather than as a pointer. `BlastRadius` imports `theLine` from `LayerStack.content.mts`
instead of restating the thesis — the cosmetic/catastrophic split is already the spine of the
three-layer diagram, and a second copy is exactly the drift the rest of the repo lints for.
