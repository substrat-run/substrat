# @substrat-run/adapter-email

## 0.2.1

### Patch Changes

- 00c0f8d: A new person's first federated sign-in no longer waits on the verification email.

  This is the asymmetry behind "sign-in works, except for people who have never signed in
  before" — a report that sounds arbitrary and is not. Exactly one thing happens on a first
  sign-in and never again:

  ```
  handleOAuthUserInfo → isRegister && !user.emailVerified && sendOnSignUp
                      → dispatchVerificationEmail
                      → runInBackgroundOrAwait(send)     ← with no handler: `else await promise`
  ```

  Both conditions hold permanently on this issuer. `emailVerification.sendOnSignUp` is on, and
  Entra does not publish `email_verified` — which Better Auth maps to `false` — so every
  brand-new Microsoft user is created unverified and gets the mail. No handler was configured,
  so that send was **awaited inside `/callback/:id`**, which has not answered yet: the browser
  is mid-redirect, looking at a page that is still loading, while the platform mail relay — the
  control plane, and then its own mail provider — decides how long it takes. A returning user
  skips all of it, which is why it looked like a property of the person rather than of the path.

  `buildAuth` now takes `runInBackground`, wired to Better Auth's
  `advanced.backgroundTasks.handler`. The Durable Object hands it `ctx.waitUntil` — which Better
  Auth cannot find by itself, since it is given a `Request` and nothing else — and the dev server
  simply does not await it, so local behaviour is the deployed behaviour. Left undefined, Better
  Auth awaits exactly as before, which is what keeps the test suite deterministic: a test
  asserting a verification mail was sent must not race its assertion against a floating promise.

  The regression test hands the transport a promise that **never resolves**, because that is the
  shape of the production failure and the only way to assert the property rather than the timing:
  if the callback waits on the mail at all, the test cannot finish. Removing the fix makes it
  time out, which is what the browser was doing.

  And the relay itself is now bounded. `PlatformRelayEmailTransport` POSTs to the control plane
  with no timeout at all, which is how an unbounded send became an unbounded page load. It takes
  a `timeoutMs` (default 10s) and passes an `AbortSignal` — a bound rather than tuning, at the one
  place in the chain that knows it is talking to a network. Defence in depth: with the handler in
  place the send is no longer in anybody's way, but a transactional mail send should not be able
  to hang regardless of who is waiting.

## 0.2.0

### Minor Changes

- 3fcf34b: Give hosted verticals a sanctioned way to send transactional mail — the resolution of the
  outbound-policy open question (#303). The sandbox deliberately keeps `send_email` off the §4
  allowlist (and a Workers-for-Platforms dispatch script cannot bind it anyway), so a vertical
  never sends directly: it POSTs to the control plane's new `POST /internal/email/send` **relay**,
  which sends on its behalf — but only if that vertical holds the staff-granted `emailSender`
  capability. The `from` address is always the platform's onboarded sender.

  The capability mirrors `tenantProvisioner` exactly, as three parts:

  - a manifest **request** — `package.json` `substrat.sendsEmail`, carried on push into the
    registry as `sendsEmail`, refreshed on every push and granting nothing by itself;
  - a registry **grant** — `emailSender`, a directory flag a push can never set or keep, flipped
    by the new staff op `setVerticalEmailSender` (and the console's "Grant email sender" toggle);
  - a platform-held **relay** — `PlatformRelayEmailTransport` (another `EmailTransport`
    implementation) on the vertical side, and the control-plane endpoint on the other, which
    re-derives _which_ vertical is calling from the named `(tenant, scope)` and checks the grant
    against that. Holding the shared `PLATFORM_SECRET` (injected into every dispatch script, and
    the relay's auth) is not enough. The control plane's own origin is injected into every vertical
    as `CONTROL_PLANE_URL` so it knows where to POST.

  `HostAdmin` gains `setVerticalEmailSender`; both adapters persist a nullable `email_sender`
  directory column (a directory schema change, not a module migration). The auth-server demo
  declares `sendsEmail` and uses the relay transport when hosted, so its Better-Auth
  `sendResetPassword` flow finally delivers on a dispatch install. Everything is additive — every
  existing manifest, registry row, and `HostAdmin` call site keeps compiling.

## 0.1.0

### Minor Changes

- b346b6c: Send team-invitation emails from the Dashboard via a new notification-transport adapter.

  - **`@substrat-run/adapter-email`** — a new host-plane adapter (D-18: a notification transport is infra the host consumes, not a tenant connector). One `EmailTransport` port with swappable implementations: `CloudflareEmailTransport` (the `send_email` Workers binding — default) and `MockEmailTransport` (dev/CI). The port owns the deliverability invariants (both html + text, a subject, a valid recipient) so no implementation can drop them.
  - **Dashboard** — `POST /api/members/invite` now emails the invitee their accept link. The send happens in the request path, where the raw address is in hand: the invites engine hashes the identifier and `invites.sent` carries only the hash, so no outbox executor could recover an address to send to. Delivery is best-effort — a committed invite is never rolled back on a send failure (`emailDelivered: false` is reported and the `acceptUrl` is still returned for a manual resend). Adds the `send_email` binding + `EMAIL_FROM` config.

### Patch Changes

- 6721e1b: Fix invite emails never sending: the Cloudflare transport serialized a nameless recipient as `{ email }`, an object whose `name` field is absent. The workerd `EmailAddress` runtime rejects that ("Incorrect type for the 'name' field on 'EmailAddress': … not of type 'string'"), so every send threw. Nameless addresses are now passed as bare strings (the documented shape); named addresses stay `{ email, name }`. The regression slipped through because the mock transport and the fake binding in the unit tests don't validate address shape like the real service.
