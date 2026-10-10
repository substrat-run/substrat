---
'@substrat-run/vertical-auth': minor
---

The legacy owner-claim redeem path is gone (#1686).

Since the release that made owner claim links `become` capabilities, a link minted the old way, by hash, was only redeemed until it expired, 15 minutes after it was minted. That path is now removed: `claimOwner` on `IdentityDO` and in `owner-seat`, and the hash branch of `mountOwnerClaim`. A token that is not a capability secret gets the one refusal and reaches neither the directory nor the scope. `migrateOwnerSeat` drops the old `owner_claim` table from existing storage.
