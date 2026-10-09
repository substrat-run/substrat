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

- **Who may mint one.** A principal mints a `become` capability only through the host's bounded verb, and only while it holds everything the target principal holds at the scope: every permission the target holds at the node (scope or tenant level, through its orgs), and every entity-narrowed grant the target holds must be one the minter can exercise on that entity. The check and the write are one scope task, and a refusal writes nothing. Two more refusals: a target holding nothing at the node (`target-holds-nothing`), since an empty set would cover trivially, and a target some `become` link has already been exchanged into in this scope (`target-already-claimed`). A member invite meets neither, since it grants the role first and mints for a principal it has just created. An invite at a role that confers no permission at all now answers `409`.
- **The link dies when its principal's holdings change.** The mint records a digest of what the target holds, and the exchange recomputes it. If anything changed (a role raised or lowered, a grant added, an org joined, a role redefined), the link is revoked with no revoker and refused, taking no use. The minter is not re-checked at the exchange.
- **Who may revoke one.** The kernel bounds the revoker itself: the link's minter, or someone holding everything its principal holds now. A refusal writes nothing, and the host verb answers `{ ok, revoked }` or the coverage.
- **Contracts.** `principalBecomeCapabilityInput` (the expiry is optional), `boundedBecomeMint`, `becomeMintRefusal` and `boundedBecomeRevoke`, and a new kernel-authored event type `capability.become-minted` (`capabilityBecomeMintedPayload`, v1), whose actor is the minter and whose entity is the capability. `capability.minted` is unchanged.
- **Kernel.** `becomeMintCheck`, `holdingsDigest`, `mintBecomeCapabilityAsPrincipal` and `revokeBecomeCapabilityAsPrincipal`. `_substrat_capabilities` gains a nullable `target_digest` column, which both adapters add to existing scopes on start. `exchangeCapability` takes an optional `holdings` dep. `PermissionChecker` gains an optional `holdings` (what a subject holds at a node, node-level and entity-narrowed), which the built-in evaluator implements. A checker without it makes the bound refuse.
- **Adapters.** `SqliteScopeHost` and `CloudflareScopeHost` gain `mintBecomeCapabilityBounded` and `revokeBecomeCapability`. Both are host methods, not module verbs. The revoke reaches only a `become` that a principal minted, never an `act` share or the platform's own claim link.
- **vertical-auth.** `mountInviteRoutes` takes three more deps, `mintBecomeCapabilityBounded`, `revokeBecomeCapability` and `exchangeCapability`, and refuses to create or withdraw an invite without the first two. `mintMemberInvite` grants the role, mints the link and records it, undoing the link and the grant if the record fails. `acceptMemberInvite` and `withdrawMemberInvite` are the shared accept and withdraw. `IdentityDO` gains `inviteMatches`, `inviteLink` and `claimInviteByCapability`. `createInvite` takes the capability id. A withdrawal revokes the link before it deletes the row, so a failed revoke leaves the row for the retry. The `invite` table gains a `capability_id` column, which the DO adds to existing storage on start.
- **vertical-host.** `/internal/members/invite` mints the link the same way, and `/internal/members/remove` revokes the link of the invite it withdraws. The host must have the two new verbs, or the member routes answer 501.
- **Invites minted before this release** still accept by their hash, through `claimInvite`. Unlike an owner claim link, an invite never expires, so that path stays until those invites are accepted or withdrawn.

Re-push a vertical that mounts the invite routes to move its new invites onto capabilities.
