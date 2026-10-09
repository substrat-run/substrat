---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/vertical-auth': minor
'@substrat-run/vertical-host': minor
---

Member invites are `become` capabilities (#1686).

The link an invite hands a new teammate used to be a token whose hash the identity directory kept on its own. It is now a `become` capability in the scope's own Durable Object, minted by the member who invites: it works once (`maxUses: 1`), can be revoked, and its mint and its use are on the scope's spine. What an invite does for people is unchanged. It still never expires, the role is still granted when the invite is made, a withdrawal still stops it, and accepting still answers one refusal for every failure.

- **Who may mint one.** A principal mints a `become` capability only through the host's bounded verb, and only while it holds everything the target principal holds at the scope: every permission the target holds at the node, and every entity-narrowed grant the target holds must be one the minter can exercise on that entity. The check and the write are one scope task, and a refusal writes nothing. The minter is not re-checked when the secret is exchanged.
- **Contracts.** `principalBecomeCapabilityInput` (the expiry is optional), `boundedBecomeMint`, and a new kernel-authored event type `capability.become-minted` (`capabilityBecomeMintedPayload`, v1), whose actor is the minter and whose entity is the capability. `capability.minted` is unchanged.
- **Kernel.** `becomeMintRefusal`, `mintBecomeCapabilityAsPrincipal` and `revokeBecomeCapabilityAsPrincipal`. `PermissionChecker` gains an optional `holdings` (what a subject holds at a node, node-level and entity-narrowed), which the built-in evaluator implements. A checker without it makes the bound refuse.
- **Adapters.** `SqliteScopeHost` and `CloudflareScopeHost` gain `mintBecomeCapabilityBounded` and `revokeBecomeCapability`. Both are host methods, not module verbs. The revoke reaches only a `become` that a principal minted, never an `act` share or the platform's own claim link.
- **vertical-auth.** `mountInviteRoutes` takes three more deps, `mintBecomeCapabilityBounded`, `revokeBecomeCapability` and `exchangeCapability`, and refuses to create or withdraw an invite without the first two. `mintMemberInvite` grants the role, mints the link and records it, undoing the link and the grant if the record fails. `acceptMemberInvite` and `withdrawMemberInvite` are the shared accept and withdraw. `IdentityDO` gains `inviteMatches` and `claimInviteByCapability`. `createInvite` takes the capability id, and `revokeInvite` returns it. The `invite` table gains a `capability_id` column, which the DO adds to existing storage on start.
- **vertical-host.** `/internal/members/invite` mints the link the same way, and `/internal/members/remove` revokes the link of the invite it withdraws. The host must have the two new verbs, or the member routes answer 501.
- **Invites minted before this release** still accept by their hash, through `claimInvite`. Unlike an owner claim link, an invite never expires, so that path stays until those invites are accepted or withdrawn.

Re-push a vertical that mounts the invite routes to move its new invites onto capabilities.
