# @substrat-run/oidc-rp

## 0.5.0

### Minor Changes

- 6ac51d1: feat: verticals built outside this repo can install the auth the starter tells them to use

  `create-substrat` scaffolds a vertical whose `/api/*` routes are 401 until real auth is wired
  into `authenticatedPrincipal`, and the template comment points the reader at
  `@substrat-run/vertical-auth` "for the intended shape". That package was `private: true` and
  absent from npm, so the pointer went nowhere: every out-of-repo vertical either hand-rolled the
  owner-claim, `sub`→principal and invite-only logic the `IdentityDO` exists to get right, or
  copied the source. Both packages are now published.

  - **`@substrat-run/vertical-auth` is published**, and ships compiled output like every other
    package here rather than raw `src`. `exports` (root plus the `./provider`, `./oidc` and
    `./oidc-rp-provider` subpaths) resolve to `dist` with declarations; `files` is `["dist"]`.
    The build follows the repo convention — `tsc -p tsconfig.json` for `src`, with the tests
    kept under their own `tsconfig.test.json` so `typecheck` still covers them.
  - **`@substrat-run/oidc-rp` is published** as its dependency. Inlining it into `vertical-auth`
    was the alternative and was rejected: the same Authorization-Code + PKCE round-trip and
    session mint/verify authenticate staff, builders and the CLI in the control plane, and
    security-critical code that has to be fixed twice is worse than one more public package.
    Its description no longer claims the platform apps are the only consumers.

  No behaviour changes — this is packaging. In-repo consumers (Callout, Meridian, Manyfold)
  import from the package root and are unaffected beyond resolving `dist` instead of `src`.

## 0.4.0

### Minor Changes

- 0caa0a9: Account switching actually works: force past the IdP SSO cookie and the browser session.

  Before this, "sign in as a different account" was impossible: `/api/auth/logout` only
  cleared the app's own `sb_session` cookie, the IdP's SSO cookie survived, and the next
  authorize round-trip silently re-authenticated the old user — no typed email could win.
  The CLI broker added a second layer: `substrat login` reused any live browser session
  without ever showing a login screen.

  **oidc-rp**: `/api/auth/login` now passes through an allowlisted `prompt`
  (`login` | `select_account`) so the IdP re-prompts past its SSO session, and
  `/api/auth/logout?federated` chains through the issuer's `end_session_endpoint`
  (RP-initiated logout, discovery-driven; local-only remains the default so other apps
  on the shared IdP session keep theirs).

  **control-plane**: the CLI login broker accepts `fresh=1` — it skips the live browser
  session and bounces through `/api/auth/login?prompt=login`, stripping `fresh` from the
  returnTo so the post-login bounce uses the new session instead of looping.

  **cli**: `substrat login --fresh` requests exactly that flow, and
  `substrat workspaces` lists your workspaces (an alias of `whoami`).

## 0.3.0

### Minor Changes

- d93e690: Detachable vertical auth (docs/design/vertical-auth-detach.md): auth moves out of the
  verticals and becomes an install-time choice — a team Auth Server app or any external
  OIDC issuer — with `builtin` (embedded Better Auth) as the unchanged default.

  **auth-server** is now a real multi-instance vertical: one issuer DO per scope behind
  the router (own users, signing secret, JWKS per install), the fixed-name single issuer
  standalone. It implements the K-31 surface (`/internal/provision`, `/internal/configure`)
  and answers unknown `/internal/*` paths with JSON — never the SPA fallback that
  surfaced as "Provisioning failed — internal error".

  **Config delivery seam** (control-plane-api): `VerticalClient.configureInstance` +
  `POST /tenants/:t/scopes/:s/configure` deliver per-instance config to the deployment
  holding the scope's DO (bound-version resolution, 501 when there is nowhere to deliver);
  `ProvisionInstanceInput` gains optional `config` so an app arrives configured
  atomically. The dashboard Env tab now delivers after authoring (`delivered` flag).

  **RP flow** (vertical-auth): `oidcRpAuthProvider` — the full server-side
  Authorization-Code + PKCE relying party as an `AuthProvider`, cookie sessions signed
  with a per-tenant DO-minted secret, bearer fallback for API clients. The IdentityDO
  stores platform-delivered per-scope config and keeps the provider-agnostic
  `sub → principal` directory (TOFU owner claim + invites) under every mode. Meridian
  selects its provider per scope from the delivered `substrat:auth`; its SPA renders a
  redirect sign-in and invite-accept in OIDC mode. jose is bumped to v6 so node JWKS
  fetching goes through `fetch`, matching workerd.

  **Install-time identity** (dashboard): the New-app form's Identity section — builtin,
  a team Auth Server (the app is auto-registered there via RFC 7591 dynamic client
  registration against its real bound hostname), or an external issuer. Wiring failures
  mark the app failed with the reason on its audit trail.

## 0.2.0

### Minor Changes

- 2add91f: Fix the invite → sign-in → accept flow so an invited person lands in the team, not on "create a team".

  - **Carry the invite through auth.** An unauthenticated invite click now round-trips through OIDC using the RP's existing `returnTo` (the callback returns to `/invite/<token>`), instead of stashing the token in `localStorage`. The accept always runs with a session in hand, so a first-time invitee joins the team rather than falling through to onboarding.
  - **Prefill + sign-up hint.** `@substrat-run/oidc-rp` `beginLogin` / `/api/auth/login` now forward `login_hint` (prefill the invited email) and an allowlisted `screen_hint` (default `signup` for invite links). Both are IdP-standard and backward-compatible for the console.
  - **Preview endpoint.** New unauthenticated `GET /api/invites/preview?token=` (backed by a no-permission `dashboard/preview-invite` op — the signed token is the authority, like accept) returns the team name + invited email for the prefill and the accept screen. It reveals only that invite's own address; access still requires the verified-email hash at accept.
  - **Graceful mismatch.** Following an invite while signed in as a different verified email now shows a clear "this invite is for X" screen with sign-out, instead of the confusing onboarding dead-end.

### Patch Changes

- b1af840: Verify an invite is for the signed-in email before accepting it. An existing member — typically the team owner — who opened an invite meant for someone else was silently switched into the team by the server's "already a member" shortcut, never learning the invite wasn't theirs. The accept flow now fetches the invite preview and compares the invited email to the signed-in email first; on a mismatch it shows the "this invite is for X" screen instead of accepting or switching. That screen's "sign out" carries a `returnTo` back to the invite link (`@substrat-run/oidc-rp` `/api/auth/logout` gains same-origin `returnTo`), so after signing out the user re-enters the invite unauthenticated and gets the sign-up screen prefilled with the invited email.

## 0.1.0

### Minor Changes

- cc5f2ca: **`substrat login` — a real browser login for the CLI (loopback OAuth, no AuthHero change).**

  `substrat login` now pops the browser and authenticates you as yourself — the `wrangler login` / `gh auth login` experience — instead of pasting a shared token. The CLI never touches AuthHero: it logs in **through the control plane**, which already brokers AuthHero for the console, and gets back the same signed session it issues to a browser.

  - **The flow (PKCE, CLI ↔ control plane):** the CLI starts a localhost server, opens `…/api/auth/cli?port&state&challenge`; the broker signs the user in (bouncing through the existing `/api/auth/login` if there's no session yet, via a new same-origin `returnTo`) and redirects to `127.0.0.1:PORT/callback?code`; the CLI exchanges `code + verifier` for the session token. The token never transits a URL — only the PKCE-bound `code` does — and the exchange fails without the matching verifier.
  - **`@substrat-run/oidc-rp`**: exports `mintSession` (refactored out of `completeLogin`), `signEphemeral`/`verifyEphemeral`, `pkceS256`, and `safePath`; `mountOidcRoutes` honours a validated same-origin `returnTo`.
  - **`apps/control-plane`**: `oidcStaffBearerReader` accepts the session as `Authorization: Bearer` (the same `verifySession`, the **same staff roster** gate as the cookie); `cli-auth.ts` mounts the broker routes. Pushes are attributed to the **human**, not a shared actor. **No AuthHero client or redirect URI is added** — AuthHero still only ever redirects to the console.
  - **`@substrat-run/cli`**: the loopback `login` flow (default); `login --token` / `SUBSTRAT_SERVICE_TOKEN` still stores a service credential for CI. `push` sends whichever the config resolves — a bearer session (per-human) or `x-service-token` (service actor).

  Verified: oidc-rp, control-plane, dashboard and cli typecheck; a new workerd test drives the whole broker end-to-end — the PKCE round-trip issues a bearer the deploy surface accepts, a wrong verifier is refused (400), and a valid session for a non-rostered user is refused (401, fail closed).
