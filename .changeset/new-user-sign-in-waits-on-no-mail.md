---
'@substrat-run/demo-auth-server': patch
'@substrat-run/adapter-email': patch
---

A new person's first federated sign-in no longer waits on the verification email.

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
