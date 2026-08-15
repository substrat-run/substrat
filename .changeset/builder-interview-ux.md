---
"@substrat-run/builder": patch
"@substrat-run/builder-generator": minor
"@substrat-run/builder-web": patch
---

Builder interview UX: the chat renders Markdown (marked + DOMPurify — plain text was the "formatting isn't working" bug); `ask_user` may be called up to 4 times per turn for coupled questions, each with a short `header`, and the UI groups them into a tabbed block answered as one combined message; every question gets an inline free-text "Other" answer; `project-named` renders as an event line instead of leaking raw JSON. The interview→scaffold dead end is now mechanically impossible: a new `denyWrite` seam on the workspace tools refuses every non-`spec/**` write during interview-phase turns (`interviewWriteGuard` in `phase.ts`, wired in both hosts), so a model cannot scaffold past an unwritten `spec/concept.md` — the refusal names the one action that unblocks it, and the prompt + interview skill spell out the approval-turn sequence (write concept → `set_project_name` → end turn). New Concept tab renders `spec/concept.md` as a reading view and auto-opens the moment the model writes it.
