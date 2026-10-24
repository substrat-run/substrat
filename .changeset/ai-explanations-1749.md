---
'@substrat-run/dashboard': minor
---

AI-written text in the dashboard, with provenance (#1749). A finding can now be explained in three or four sentences (**Observability → Findings → AI explanation**), and a process map can carry a short note under its diagram (**AI note**). Each paragraph shows an **AI** marker and a provenance line: when it was written, from how many records and which sources, each linking to where it is checked. The dashboard counts that line itself; the model writes only the paragraph.

- Nothing is written until a person asks, and opening the block only reads the text already filed, so a page load calls no model. An explanation written from older evidence is marked so and offers a rewrite (acknowledging a finding is not new evidence); a process note does so after a slice of its period, since its window rolls with the clock.
- What reaches the model is a field allowlist, never a row, and error messages are redacted first (keys, tokens, passwords, URL credentials, email addresses, phone numbers). Tenant, scope, person and record ids are never sent.
- Runs on Workers AI through the platform's model host (`AI` binding, default `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, `AI_EXPLANATIONS_MODEL` to change it). The platform pays, within 20 texts per person and 100 per team per UTC day. A unit is reserved in the team's scope before the call and settled filed or failed after it, so parallel requests cannot each pay and a failed call is still on record. Texts and their token usage are kept in the team's dashboard scope for 90 days (migration `0015-explanations`).
- Off unless `AI_EXPLANATIONS=1`; on in TEST only. Where it is off the toggles are not drawn and nothing is read.
