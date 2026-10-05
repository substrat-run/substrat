---
'@substrat-run/adapter-cloudflare': patch
---

A kill switch can be turned off again on a vertical that has not been re-pushed since the switch fence (#2045). Before this change, `revokeFromSystem` and `revokeFromPeer` refused `precondition_failed` on every hosted scope whose deployment predates the fence. Every re-assert of such a scope threw as well, so a reconcile, provision or restore of a scope with a recorded-off module or peer failed instead of switching it back off.

On a deployment without the fence, only an ON is refused now. The fence exists to stop an older OFF from landing after a newer ON. With every ON refused there, no newer ON exists for an OFF to land after, so an OFF goes through unfenced. Its admin-log row says `unfenced: true`, and its subject stays owed a re-assert. The scope's reconcile receipt stays unwritten, so after the vertical is redeployed, the first re-assert moves the scope again under the record's fence.

A re-assert on such a deployment applies every recorded OFF. If it owes an ON, it does not send it and refuses at the end, so the sweep records no receipt for that scope. A deployment that attested the fence and then answers a move without it, a rollback mid-call, is still refused as before.
