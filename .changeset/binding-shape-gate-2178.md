---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/control-plane-api': patch
'@substrat-run/contract-tests': minor
---

A version can no longer strand people a link bound (#2178).

People a binding invite bound to their record keep the shape until they are released, and every way of releasing them needs the shape: an unbind needs it to bind, a retirement needs it to be a bootstrap shape, an erasure finds them through the holder the scope recorded. A version that removes a binding shape, moves its holder to another table or column, turns it into a sharing shape, or drops a key from it without retiring that key is now refused wherever it would come to run where the shape binds: a promote (judged against the channel's version and against each owned scope a private promote re-points), a bind, and a route onto a serving script. A rollback to a version from before the shape is refused the same way. No acknowledgement passes it. Retiring is the way through: keep the shape with every key in `retired` and none in `permissions`, then drop or move it in a later version. Dropping only `bind` is still allowed.

- contracts: `bindingShapeBreaks`, `bindingShapeRefusal` and `BINDING_SHAPE_REFUSAL`; `assertNoBindingShapeBreak` judges two stored manifests and fails closed on grant shapes it cannot read. The registry diff reports a holder change (`grantChanges[].holder`, read by `holderLabel`), and `grantShapeHolderNotes` says it, so every review of a promote shows it.
- kernel: `scopeMoveOf`, the before/after running versions of a bind or a route change, shared with the export-break gate.
- adapters: `promoteVersion`, `bindScopeVersion` and `setScopeServingRef` refuse such a move `precondition_failed`, ahead of the acknowledgements. `bindingImpact` refuses it too, so a caller that asks before moving data stops first.
