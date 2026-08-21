---
'@substrat-run/connector-scrive': minor
'@substrat-run/demo-meridian': minor
---

The Scrive account holder is the sender, never silently a signatory (#852).

**Scrive binds the author party to the API account holder and silently overwrites the `name` and
`email` the caller sends on it.** Measured against `api-testbed.scrive.com`, not inferred: a party
sent as `Not The Account Holder <someone.else@example.com>` with `is_author: true` comes back
carrying the account's own name and address, with no error. Sending no author party does not avoid
it — Scrive claims party #1 and overwrites that instead. None of this is in Scrive's documentation,
which describes `is_author` as read-only and says nothing about identity substitution.

This connector mapped `signatureKind: 'primary'` → `is_author: true`, so that substitution decided
who signs for the sender's organisation. Two things followed, both of which reached production:

- **The wrong person signed.** Egeryds issued an avtal naming one signatory and a different
  person — the Scrive account owner — was invited to sign it. No amount of contact-field plumbing
  could move it, because the address was being discarded at the provider.
- **That signature could never be recorded.** `reconcileScriveSignatures` refuses to attribute
  when the provider's party name disagrees with the dispatched label — a fail-closed guard doing
  its job — and a substituted name never agrees. The document could not complete.

## The change

The account is sent as a **non-signing author** (`is_author: true`, `is_signatory: false` →
`signatory_role: "viewer"`), which is what it actually is: the sender. Every party the vertical
names is an ordinary signatory that keeps its own identity. A named signatory whose address
happens to equal the account holder's stays a separate signing party rather than folding into the
author — verified live, because that is the case the design turns on.

`ScriveDispatchState.senderParty` records that a sender party was sent, because the reconcile
matches the Nth signatory to provider party N+1. State written before this change has no
`senderParty`, reads an offset of 0, and reconciles exactly as it did before — so a dispatch
already in flight is unaffected.

## Breaking: every party now needs an address

The issuing party used to be exempt, on the reasoning that an author is reached as the account
rather than invited. That exemption is gone with the author, so the rule is the simple one: every
party signs, so every party must be reachable by email or mobile. A dispatch that cannot invite
someone is **refused before egress, naming the party** — where Scrive's own answer is `409
Invitation delivery for participant #2 requires valid email field`, a positional index into a list
the vertical never saw, which cost a production afternoon to read (#841).

Callers that relied on the exemption must now supply a contact for the issuing party. Meridian
does: the employer signs its own employment contracts, so the issuing HR user is looked up in the
employee directory and refused by name when they have no address — and Hedda is seeded as an
employee in both scopes she administers, because a scope is its own world.

This also closes README caveat 2's "starts, reports itself sent, delivers to nobody" row, which
that caveat had asked for as the carrier's companion invariant.

## The mock now models the provider

`ScriveMock` substituted nothing, so every test agreed with a connector that was wrong in
production — the exact failure mode the README warns about ("the mock *is* our reading"). It now
stamps the account holder onto the author party, and closes a document when every **signatory**
has signed rather than every party, since a viewer never signs.

**Permission diff:** none. **Migration diff:** none.
