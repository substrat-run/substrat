---
"@substrat-run/engine-protocol": minor
"@substrat-run/connector-scrive": minor
---

fix: the signature request chooses how a party authenticates — `se_bankid` is no longer hardcoded

Every document `connector-scrive` had ever sent was refused by Scrive:

```
scrive start failed: HTTP 409
Authentication to sign for participant #1 requires valid personal number field.
```

The connector picked the authentication method from the party's `kind` — `se_bankid` for any
external signatory — and Scrive's BankID auth-to-sign will not start without a `personal_number`
on the party. Substrat deliberately supplies none: a party's `ref` is an opaque `DataSubjectId`
because design rule B6 says a personnummer never reaches the kernel, the events or the audit
trail. So the connector demanded something the caller could neither see nor satisfy, and a
production tenant lost a fortnight of contracts to it.

- **`signatureRequestParty.authLevel`** — `basic` (the provider establishes control of a contact
  address) or `strong` (a national eID), defaulting to `basic`. Deliberately *not* the provider's
  vocabulary: `se_bankid` is Scrive's word and belongs in the connector that speaks to Scrive,
  or an engine serving several providers would be handing verticals one provider's enum. Stored
  nullable (migration `0003-party-auth-level`) so rows written earlier read as the default, and
  resolved onto `protocol.signatures-requested` so no consumer re-derives it.
- **`ScriveConnectorOptions.defaultAuthMethod`** — what `basic` means for this connection,
  `'standard'` by default. That default is the fix. A deployment that supplies personal numbers
  by other means can set `'se_bankid'` and keep the old behaviour deliberately.
- **`strong` is refused before any egress**, with a sentence naming why it cannot be satisfied,
  instead of being sent for Scrive to answer with a bare `409` that reached nobody. The
  resolution happens *before* `documents/new`, so a refusal leaves no orphan draft at the
  provider — the earlier draft of this fix threw while building the `update` body, and a
  retrying delivery would have littered one document per attempt.

Callers need no change: a party that says nothing gets `basic`, which is what `standard` already
meant for principals. **What this does not do** is carry a party's contact detail (ask 1 of the
issue) — that needs a lawful carrier for direct PII from module code to a connector, which does
not exist and is tracked separately. Until it does, `strong` is reachable only by a deployment
supplying personal numbers by other means.
