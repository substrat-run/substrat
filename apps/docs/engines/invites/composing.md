---
description: "Calling the invites engine from your own operations, delivering the invitation yourself — the engine sends nothing — and a worked example of the join flow, with what not to do."
---

# Invites: composing & extending

## From a vertical

Call the exported in-scope functions inside your own operation, in the same
transaction, having checked your own permission first:

```ts
import { sendInvite } from '@substrat-run/engine-invites';

const inviteColleagueOp: OperationHandler<{ email: string }, { id: string }> =
  async (ctx, input) => {
    assertAllowed(await ctx.check(MYAPP_PERM.manageTeam));
    return sendInvite(ctx, {
      orgId: myOrgFor(ctx),
      identifier: input.email,
      roleKey: 'colleague',   // YOUR vocabulary
    });
  };
```

The engine never decides who may invite, what a role means, or how the invitation
reaches the recipient. Those are the vertical's.

## Delivering the invitation

The engine records that an invitation exists; it does not send email. That is
deliberate — delivery is an effect on the outside world, so it belongs in a connector,
not in module code (which cannot reach the network at all).

Consume `invites.sent` in a connector and send whatever your product sends. The event
carries no identifier, so the connector resolves the recipient from your own records —
which keeps the address out of the spine.

## A worked example

`demos/rally` is the reference: [RallyPoint](/verticals/rallypoint#invites-joining-the-club)
composes `sendInvite` in `rally/invite-player`, keeps the player's name and party ref in
its own `rally_invited_player` table keyed by the invitation id, and creates its
`rally_members` row from a consumer on `invites.accepted`.

## Extending it

**Extra states** belong in your vertical as substates, not as forks of the machine.
The engine's four states are about *whether the offer stands*; anything about your
onboarding flow is yours.

**Extra data** on an invitation goes in your own table keyed by the invitation id. The
engine's table is private, as every module's is.

## What not to do

**Do not report whether an address is already invited or already a member.** Every
affordance that distinguishes those cases turns the invite surface into a membership
oracle. If your UI wants to say "already on the team", derive it from your own
membership list for people the caller can *already see* — never from the invite path.
