---
"@substrat-run/contracts": minor
"@substrat-run/kernel": minor
"@substrat-run/adapter-sqlite": minor
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/contract-tests": minor
"@substrat-run/control-plane-api": minor
"@substrat-run/vertical-host": minor
"@substrat-run/dashboard": minor
"@substrat-run/dashboard-web": minor
---

fix: a connector failure is readable, and a refused request is no longer retried for two days

The console's card for a broken Scrive connection said, in full: `Error · scrive · Last error 7m
ago: HTTP 409 from scrive`. The real message was nine words longer and contained the whole
answer — `Authentication to sign for participant #1 requires valid personal number field`. It
was journaled correctly by `settlePlatformRequest` and retained; it was simply not reachable
from anywhere a builder would look. Getting at it meant the read-only SQL console with system
tables toggled on, or a break-glass `scope pull --full`.

It cost a production tenant a fortnight. Three signature requests, none of which ever reached a
counterparty: two `failed` after **100 attempts over two days**, one still `pending` at 78 and
counting — all on the same permanent client error. The contracts sat in `pending_signature`
throughout, and the app had nothing to tell the user.

- **The intent journal is readable.** `_substrat_platform_requests` had one reader,
  `listPlatformRequests`, which returns only `pending` rows — so a *settled* intent, the only
  kind that holds an answer, was invisible by construction. Its complement,
  `ScopeHost.listPlatformRequestHistory` (`kind` / `status` / `limit`, newest first), is served
  through the vertical's `/internal` surface and the control plane's new
  `GET /tenants/:t/scopes/:s/intents`, and rendered in the dashboard's integration detail as
  "Delivery attempts": id, status, attempts, timings, what was sent, and `lastError`
  **verbatim** — truncating it would rebuild the exact wall the section exists to remove.
- **A 4xx settles terminal on the first attempt.** `pending` means *try again*, and every throw
  got it by default: right for a provider outage, wrong for a provider's refusal. A 4xx is the
  provider telling the caller its request is wrong; attempt 101 sends the identical bytes.
  `isTerminalProviderError` classifies structurally on the error's `status`, so no host imports
  a connector's error class — and 5xx, 408, 423, 425, 429 and anything with no status stay
  retryable, because a failure you cannot classify must never be settled terminally. Two days of
  silent retries becomes one settled row with the provider's own sentence on it.
- **A terminal settle is visible to an operator.** It now lands an ops-failure row
  (`stage: 'terminal'`), the same treatment the attempt ceiling already had. A give-up and a
  refusal end the same way — nobody is coming back to the intent — so they deserve the same
  headline.
- **A vertical can read the outcome of its own intents.** `ctx.platformRequests(filter)` is the
  read half of `ctx.requestPlatform`, which had none: an app could ask the platform to do
  something and then had no supported way to learn whether it happened. This is what lets a
  contract screen say the signing request never left, instead of showing a document that appears
  to be out for signature and is not. Read-only by construction — the kernel owns every write to
  that table.

`ScopeHost` gained `listPlatformRequestHistory` and `OperationContext` gained
`platformRequests`; both in-tree adapters implement them and the contract-test suite holds them.
The 409 itself is a connector/engine gap, filed separately.
