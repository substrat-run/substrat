---
'@substrat-run/vertical-auth': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': patch
'@substrat-run/kernel': patch
---

Owner claim links are `become` capabilities (#1686).

The claim link the dashboard's Owner seat card hands an installer used to be a token whose hash the identity directory kept in a table of its own. It is now a `become` capability in the scope's own Durable Object: it expires after `OWNER_CLAIM_TTL_MS` (15 minutes), works once (`maxUses: 1`), can be revoked, and its use is recorded on the scope's spine as `capability.exercised`. What a claim link does for the installer is unchanged: the 15-minute first-sign-in window, "a new mint retires the old link", and one refusal for every failure.

- `mintOwnerClaimLink` takes the identity directory and the scope host, the scope's `{ tenantId, scopeId }`, the origin, and optionally the platform actor that asked: `mintOwnerClaimLink({ directory: identityDo(env, ref), host: hostFor(env) }, ref, input.origin, input.actor)`. It mints the capability, records it in the directory as the current link, and revokes the previous one.
- `mountOwnerClaim` (new subpath `@substrat-run/vertical-auth/owner-claim-routes`) is the redemption, `POST /api/claim-owner`, so a vertical no longer writes its own. It refuses a signed-out caller before reading anything, checks that the secret is the current link before exchanging it (so a stale or unrelated secret is refused without spending its use), exchanges it, and binds the signed-in subject. `noun` and `onClaimed` cover the parts a vertical owns.
- `IdentityDO` gains `ownerClaimTarget`, `recordOwnerClaim`, `ownerClaimMatches` and `claimOwnerByCapability`, and loses `mintOwnerClaim`. `claimOwner` stays, redeem-only, for links minted before this release: those still work until they expire, at most 15 minutes after the deploy, and a new mint deletes them. It is removed in the next release.
- `CloudflareScopeHost.mintCapabilityLocal` and `revokeCapabilityLocal` are the platform's `become` mint and revoke for the deployment that serves a scope. They are host methods, not module verbs: module code mints through `ctx.capabilities`, which mints `act` capabilities only.
- `plausibleCapabilitySecret` (kernel) is the exchange's own first check on a secret, exported for the redemption route.
- `/internal/owner-claim` accepts an optional `actor`, which the control plane now sends and the `mintOwnerClaim` hook receives as `input.actor`, so the capability records who asked.

Re-push a vertical to move its claim links onto capabilities. Until then it keeps minting the old way.
