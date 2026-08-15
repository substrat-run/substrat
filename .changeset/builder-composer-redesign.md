---
'@substrat-run/builder-web': minor
---

feat(builder-web): OpenCode-style composer — model picker in the prompt box, arrow send, file attachments

The chat composer becomes one rounded card: textarea on top, a controls row
below with a `+` attach button, the model chip (moved out of the header —
opens the same picker), and a square `↑` send button that turns into `■` stop
while a turn runs. Files attach via the `+` button or by dropping them
anywhere on the chat column (dashed overlay, staged as removable chips) and
are saved to the project as `attachments/<name>` through the existing
`PUT /api/file` seam — both hosts already serve it — with the sent message
naming the paths so the generator reads them with its normal workspace tools.
Honest v1 bounds: text files only (null-byte check), 512KB cap — the
generator could not open a binary anyway. A failed save keeps the draft and
chips instead of losing them.
