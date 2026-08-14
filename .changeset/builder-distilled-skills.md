---
"@substrat-run/builder": patch
"@substrat-run/builder-generator": minor
---

Builder-distilled skills + the phase ladder (D-54/D-55). The generator's skills are now studio-owned files under `apps/builder/skills/` — the repo's Claude Code skills assumed monorepo access and denied tools — split four ways (`platform`, `interview`, `scaffold`, `iterate`) and gated by a phase ladder derived from workspace facts: interview (no `spec/concept.md`), scaffold (no `src/module.ts` yet), iterate. A shared manifest (`phase.ts`) drives both hosts, so prefix content changes only at phase boundaries and each phase's prefix caches independently; mature-project turns drop the ~5k of scaffolding skeletons. A new `phase` BuildEvent (studio-emitted, never model-claimed) feeds a top-bar phase stepper in the UI — what the user sees is exactly what the generator is loaded for. Also fixes the hosted host detecting the phase before the R2 restore (a slept container read an empty disk and loaded interview skills for mature projects).
