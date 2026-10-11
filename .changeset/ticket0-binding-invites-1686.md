---
'@substrat-run/demo-ticket0': minor
---

Customer invites bind the customer to their contact (#1686).

A customer invite is now a binding invite. Claiming it sets the contact's `principal` to the customer and gives them the portal on that contact, in one transaction. Staff invites are vertical-auth's capability links (`mintMemberInvite`), and the desk writes no hash-only invites any more. Inviting a customer takes the new key `contact:invite`, which only `desk-admin` holds.

**A contact takes one portal customer now.** Under the earlier `'grantee'` holder, a contact could have several. On a desk that already has portal customers:
- a contact any of them holds refuses a new customer invite (409, "already has a portal customer from an earlier invite") until it is unbound;
- unbinding it (`POST /api/bindings/contact/:id/unbind`) releases **all** of the customers holding the portal there;
- withdrawing a pending customer invite from before this change leaves its pre-minted principal holding the portal, because that invite granted it at creation. That contact therefore also answers the 409 until it is unbound.

Operators should unbind a contact before re-inviting to it. Existing portal customers keep their portal until then.
