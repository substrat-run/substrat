---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/vertical-host': minor
'@substrat-run/engine-protocol': minor
'@substrat-run/connector-scrive': minor
'@substrat-run/engine-test-kit': minor
---

A signature request can carry **how a party is reached** — sealed to the
connector, never readable in the spine (#687 item 1,
`docs/design/signature-contact-carrier.md`).

Every external signature this platform has ever sent has failed. The reason was
not the auth level and never was: `connector-scrive` mapped each party to a role
label — "Beställare" — and no address, so Scrive answered
`invalid_invitation_delivery_info` and a document started with nobody to deliver
it to. `ScriveParty.email` was declared, wired into the provider's `fields`
array, and filled by nothing. This is its producer.

**Why it took a design.** The obvious carrier — put the address on the event —
is unavailable: `protocol.signatures-requested` lands in `_substrat_outbox` and
`_substrat_platform_requests`, kernel rows a vertical may neither write nor
erase, so anything a hosted vertical emits in plaintext stays plaintext in copies
it cannot reach. The next obvious one — seal it under the per-subject keys — is
impossible rather than merely awkward: those keys live in the directory, and a
sandbox-clean vertical is architecturally on the far side of that boundary
(§2 of the design derives it). And reading the contact back at egress deadlocks,
because a connector runs *inside* the scope's dispatch and re-entering the scope
actor wedges it.

What works is the gap in the middle: a scope may never hold a *secret* key, and
nothing says that about a *public* one.

- **`sealTo` / `openSealed` in the kernel** — the asymmetric sibling of
  `SecretBox`: ECDH P-256 → AES-256-GCM, a fresh ephemeral keypair per seal, and
  an envelope that is a `SealedSecret` so it carries `keyId`. A cell that cannot
  name its key can only ever have one, and every ciphertext already written
  becomes ambiguous the day a second exists. Rotation is deferred; the envelope
  that permits it is not.
- **A keypair per connection.** The private half is sealed under the host
  `SecretBox` beside the credential and stored **keyId-indexed from day one**,
  even holding one member — widening a column into a set later is a migration
  against live connections. Minted on first ask, so a connection older than this
  feature acquires one by being asked rather than by being reconnected.
- **The public half is projected into the scope**, on the channel that already
  carries entitlements, identity links and connection grants — not
  `configureInstance`, because a key in the config bag becomes a key in a
  settings form.
- **`ctx.sealToConnection(provider, plaintext)`** — awaited *before* `ctx.emit`,
  so `emit` stays synchronous and D-28 is untouched. **Fails closed and legibly**
  when no key has reached the scope: emitting a request with its addresses
  silently dropped is the invisible failure this exists to end.
- **`conn.unseal(cell)`** at egress, on the connection for the same reason
  `fetch` and `openAttachment` are — key material never crosses into connector
  code.

`engine-protocol` gains `partyContact { email?, mobile? }` on
`signatureRequestParty` and migration `0005-party-contact`, which stores **only
the ciphertext**. There is no plaintext column to clear later and no erasure
story to write: the address is unreadable to the spine, to its backups and to
`sealDump`'s output, because the key that opens it is in the directory.
`piiClass` therefore stays `'none'` — see the migration's own note for why
`'pseudonymous'` would be actively wrong rather than more honest.

**No `personalNumber` field, and its absence is the decision.** #687 measured the
premise and it is false: what a provider validates is that a BankID party *has*
the field, not that it holds a value. An optional PII field on an engine surface
is a carrier that exists.

Two invariants ship with the carrier, both in `requestSignatures`, both refusing
before anything freezes:

- **A party that will be invited must be reachable.** Otherwise the provider
  refuses after the instance has already frozen, leaving an avtal that looks sent
  for signature and is not.
- **A set with no counterparty is refused.** "The declared primary, else the
  FIRST" is a total function, so a one-party request never failed here — it
  failed at the provider, where that party had been made the *author*, and an
  author is never invited. In production that party was the customer.

Verified against the Scrive **testbed**, not only the mock: a party carrying an
address no longer draws `invalid_invitation_delivery_info` at either auth level,
and a document with one starts and reaches `pending`. The connector tolerates an
absent contact in both skew directions — an older engine sends none, an older
connector strips the field — so neither combination is worse than today, which is
that nothing works.
