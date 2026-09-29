---
'@substrat-run/connector-scrive': patch
---

A dispatch made before Scrive party ids were stored is now pinned to its parties by position only when the parties' names bear that position out. Until now, the first poll pinned the ids whenever the party count and roles still lined up, and never read a name. Two parties that changed places at Scrive, or two parties renamed at once, were pinned to each other's requests, so each signature was recorded against the other party.

Pinning now also requires one of two things: every signing party's name is still its dispatched label, or exactly one name differs, its label is on no other signing party, and its new name is not another party's label. The sender slot is not compared, because Scrive rewrites it to the account holder. When no ids are pinned, the position fallback now also refuses a party that shows no name, or whose name another signing party also shows. Every refusal is reported under "needs attention" instead of being recorded.
