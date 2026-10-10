---
'@substrat-run/contract-tests': patch
---

The cross-vertical events suite holds an erasure to treating an import's delivery the same in `_substrat_import_replays` as in `_substrat_deliveries`. After a subject erasure, a replayed import's moved-aside delivery error must equal its live one, on every adapter. Today no erasure reaches either. A released import is always `piiClass: 'none'`, so no subject link names the handler's error text. A withheld import, including a classified one, gets a dead letter whose error is the platform's own note, which names no one. An erasure that later reaches the live row and not the replay history fails the suite with a message that names the fix. The fixture's board module gains `board/note-member`, which emits a classified event whose local consumer fails, as the case's control.
