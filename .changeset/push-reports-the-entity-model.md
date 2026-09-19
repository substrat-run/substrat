---
'@substrat-run/cli': minor
---

`substrat push` and `substrat push --check` now say what they are doing about the entity
model: `entity model: 19 entities (model.json)` when the vertical carries one, and a
one-line `note:` naming the artifact when it does not.

The absence of a `model.json` is still legitimate and still pushes — a vertical that has
not adopted the entity registry is not an error and this does not make it one. What it
stopped being is silent. The CLI has had the fact in hand since #1214 and printed it
nowhere, so the first and only place a builder learned their deployed version carried no
model was the dashboard's Model tab, after a successful deploy, telling them so. That is
the wrong end of the loop for something a local gate could have said before the upload.

Stated in both directions deliberately: the count on a push that DOES ship a model is what
makes its absence conspicuous the next time, and it is the cheapest confirmation that the
file being emitted is the file being shipped. Under `--check --json` the line rides stderr
beside the lint notes, so the registry stays the only thing on stdout.
