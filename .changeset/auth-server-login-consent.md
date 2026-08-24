---
'@substrat-run/demo-auth-server': minor
'@substrat-run/demo-auth-server-app': minor
---

auth-server: the OIDC login and consent pages exist

`src/auth.ts` has always told Better Auth to send people to `loginPage: '/login'` and
`consentPage: '/consent'`. Neither page existed. Both fell through `routes.ts`'s
`app.all('*', serveAsset)` to the admin SPA, which chose its screen from session state alone and
never looked at `location.pathname` — so a relying party that registered itself was dropped
mid-round-trip and the person landed on an admin dashboard they had not asked for (#898). Found
pointing a real vertical at a deployed instance: sign-in appears to work, and the app is simply
never told about it.

**The issue's account of the mechanism was half right, and the other half is the fix.** The
abandoned login resumes on its own: Better Auth stashes the authorize request in the signed
`oidc_login_prompt` cookie, and an after-hook notices the new session, re-runs `authorize`, and
answers the *sign-in* request with `{ redirect: true, url }`. The browser client's default
`redirectPlugin` navigates on exactly that shape. So the redirect did happen — to `/consent`,
which rendered the dashboard. Both reported symptoms were one missing page.

- **`/consent`** is a real screen: it names the relying party (from `oauth2/client/:id`, so a
  dynamically registered client's self-chosen name is shown as a claim with its client id
  underneath), spells out each requested scope, and posts the answer to `oauth2/consent`.
  Allow returns the RP's callback carrying the code; **Deny returns it carrying
  `access_denied`** — a denial is an answer the relying party receives, not a dead end.
- **`/login`** renders sign-in *even when a session already exists*. This is not redundant:
  `prompt=login` and an expired `max_age` are re-authentication requests, and answering one
  with the dashboard stranded the flow exactly as `/consent` did.
- `signIn` now reports whether an authorize request took over, so the app does not re-render
  the dashboard over a page that is already leaving. It applies to first-run bootstrap too —
  creating the first admin can itself be the answer to an RP's authorize request.

**Why the suite stayed green, and what now keeps it honest.** The only entry in `trustedClients`
is the seeded demo RP, and it sets `skipConsent: true`. A trusted client with a session touches
neither `loginPage` nor `consentPage` — so the two redirects that were broken were precisely the
two the demo never took, while `allowDynamicClientRegistration: true` exists to invite the
clients that take both. `test/untrusted-client.test.ts` drives a client that registers itself,
through register → authorize → resume-on-sign-in → consent → token, and asserts an id_token
comes back. It also pins the redirect targets and the `consent_code` / `client_id` / `scope`
parameter names: those are Better Auth's choices, not ours, and the SPA is built on them.

Verified in a browser against the running demo, not only in vitest: a self-registering RP
completes sign-in → consent → callback and redeems a signed id_token; deny reaches the RP as
`access_denied`; an already-consented client is not asked twice; `prompt=login` re-authenticates
and completes; `prompt=none` is still answered at the RP with `login_required` without any UI;
and the operator's dashboard is unchanged.
