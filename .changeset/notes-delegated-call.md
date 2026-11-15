---
'@substrat-run/demo-notes': minor
---

Todo may call Notes as the person signed in to it, with the notepad's keys only (`delegations` in the manifest, the `peer` channel). Item notes have keys of their own, `item-note:read` and `item-note:write`, which `writer` holds and the delegation does not, because their operations rely on the door's vouch from Todo (#3161). Todo is declared a peer here, allowlisted for nothing and seated with `todo-peer:admit`, so the operator's peer switch for Todo stops its calls made for people too.
