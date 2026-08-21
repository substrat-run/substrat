---
'create-substrat': patch
---

One name for the design document: `spec/concept.md`.

The playbook told a scaffolded project to write `DESIGN.md` in the project root, while every
demo, the docs site, the builder studio and `CLAUDE.md` called the same artifact
`spec/concept.md`. Two names for one file — and the root/`spec` split put it in a different
directory from `spec/model.ts`, which is that same design one rung more concrete.

`spec/concept.md` wins because it is the name everything mechanical already keys on:
`apps/builder/src/phase.ts` detects the interview phase by its absence and
`interviewWriteGuard` refuses every non-`spec/**` write until it exists; the eval fixtures
and `tools/model-diff.mts` name it; D-56 encodes it as a phase-ladder fact. `DESIGN.md`
appeared only in prose instructions, never in code.

The old rationale — `DESIGN.md` for a standalone project, `spec/concept.md` inside the
monorepo — was already false when it was written: the builder generates standalone projects
and writes `spec/concept.md` into them.

So the three artifacts now read the same everywhere, one role each:

| artifact | says | written by |
| --- | --- | --- |
| `spec/concept.md` | what the business is | human, approved |
| `spec/model.ts` | what exists | human-approved, AI-drafted |
| `src/` | how it behaves | AI, gated |

**No `spec/` ships in the template, on purpose.** A pre-made `concept.md` would mark the
interview as already done — exactly the fact the phase ladder reads — so the agent creates
the directory when it writes the file at Step 3.
