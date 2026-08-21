---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/vertical-host': minor
'@substrat-run/dashboard': minor
'@substrat-run/control-plane': minor
---

A delivery refused before egress stops being captioned as the provider's refusal.

A `connector:<provider>` dispatch crosses two authorities. On the way to the bytes it calls back
into the VERTICAL — opening the bound attachment, invoking the return-path operation — and that
call is checked against the connection's grants. Only once those pass does anything reach the
provider. Both ends refuse by throwing, both landed in the same `lastError` string, and nothing
recorded which was which.

So the drain asked `isTerminalProviderError`, which reads a bare numeric `status` — and every
`SubstratError` carries one from the problem catalog. A `permission denied: protocol:read` raised
inside the vertical answered `true`, and the delivery was journaled as *"a client error the
provider will refuse identically on retry"*. Scrive never received that request. The integration
drawer then captioned it *"what Scrive said, in full"*, and directly above it rendered the grant
list that did not contain `protocol:read` — both halves of the diagnosis on one screen, inches
apart, with nothing saying one was the other's answer. The operator went to audit their Scrive
account, pressed **Test connection** (which passes, because the credential is fine), and concluded
the platform was broken.

## Terminality and attribution are different questions

`isTerminalDispatchFailure` decides whether to retry and is deliberately blind to who refused: our
own `validation_failed` is as final as the provider's 409, and both statuses come from the same
structural read. `isTerminalProviderError` now answers only "may this be quoted as the provider's
words", and one of ours never may.

**No delivery changed its retry behaviour.** That part was never wrong, and moving it would have
been a silent semantics change smuggled into a bug fix — a permission denial still settles terminal
on the first attempt rather than burning a hundred drain passes. What changed is what is *said*
about it.

## The attribution is a value, not a sentence

`PlatformRequestFailure` (`origin`, `code`, `permission`) is journaled beside `lastError` in the
scope's own spine, so no reader parses prose to learn who refused. `origin: 'unknown'` is a real
answer — a socket that never opened is not the provider's refusal either — and NULL is a different
fact again: nobody classified this row, rather than somebody classifying it as unattributable. The
column is additive and nullable, so an intent settled by an older control plane reads as
unrecorded rather than acquiring an origin nobody decided.

## A `ControlPlaneError` is always ours

It is constructed in exactly one place — a call *we* made to the vertical's `/internal` surface came
back non-2xx — so whatever status it carries is the vertical's answer to the platform, never the
provider's to us. This is the rule that fixes the reported failure, and it is why the correction
lands in the control plane alone: a 403 raised by a deployment that predates this change is still
attributed correctly, with no vertical redeploy in the path.

The permission key is read from the structured field when it survived the hop, and recovered from
the kernel-authored `permission denied: <key>` message when it did not — applied ONLY to a failure
already attributed to us, so a provider echoing the phrase can never be re-read as our own refusal.
Nothing parses prose to decide the origin.

## The drawer joins what it was already rendering

A failed delivery naming a permission absent from the connection's live grants now says so where
the failure is. When the key IS held the sentence is deliberately not written — that is a different
bug, and guessing at it would rebuild the wall this removes. The panel-level caption no longer
claims the provider's voice for deliveries it cannot attribute; it says less instead of guessing.

**Permission diff:** none. No permission key, role or grant changes.

**Migration diff:** one nullable spine column (`_substrat_platform_requests.last_failure`), added by
the same attempt-and-tolerate `ALTER` both adapters already use for `authorization` and
`revoked_at`. No module migration. The pending-intent read in both adapters also adopts
`PLATFORM_REQUEST_COLUMNS`, which it had duplicated — that duplication is what the constant exists
to prevent, and it drifted the moment a column was added.

Closes #841 steps 1 and 2. Step 3 was declined with #726 (the repair is a reconcile, not a button)
and step 4 shipped there as `lint:connector-grants`.
