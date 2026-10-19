---
"@substrat-run/contracts": patch
"@substrat-run/control-plane-api": patch
"@substrat-run/control-plane": patch
"@substrat-run/social-relay": minor
"@substrat-run/demo-auth-server": minor
---

An Auth Server install now gets platform-provided social sign-in without anyone registering anything: GitHub (and later Google and Apple) through the platform's social relay at `id.substrat.net`, offered on the install's **Sign-in providers** screen as a switch that starts off (#1544).

**Auth Server.** A new platform delivery, `substrat:social-relay`, carries the install's client at the relay and the providers the relay serves. Each provider becomes a `<provider>-relay` sign-in provider, created switched off.
- A later delivery keeps the operator's three decisions (enabled, creates accounts, trusted email) and replaces only what the platform owns.
- A provider of the operator's own under the same id is never touched. One configured against the relay by hand is adopted.
- A provider the relay stops serving is switched off.
- On the screen, these providers say "provided by Substrat". They show the switches and no credential form, and cannot be removed, only switched off.
- A delivery without a secret keeps the one held. When none is held, `/internal/configure` answers 409 `social_relay_secret_needed`.

**Control plane.** `socialRelay` on `createControlPlaneApi` reconciles one install's client at the relay:
- It reads the relay's live providers and builds callbacks from the install's active hostnames. A custom domain counts only once Cloudflare reports it verified, asked at that moment.
- It ensures the client under `scope:<scope id>` and delivers the entry. The secret is rotated only when the install answers that it holds none.
- It runs when a hostname of an Auth Server install becomes active, through the bind, verify and status routes and the hostname sweep (`reconcilePendingHostnames` takes `onActivated`). That covers install time and every custom domain.
- Two staff-only routes, `POST /tenants/:t/scopes/:s/social-relay` and `POST /social-relay/reconcile`, reconcile one install or all of them, for example after the relay gains a provider.
- The worker reaches the relay through a `SOCIAL_RELAY` service binding, with `SOCIAL_RELAY_ORIGIN` set per environment.

**Relay.** New endpoints:
- `GET /providers` lists the providers it can serve, with their endpoints.
- `PUT /internal/clients/by-ref/:ref` ensures one client per install, returning the secret only on create.
- `POST /internal/clients/:id/secret` rotates a client's secret.
- A client now takes up to 64 redirect URIs.
- A disabled client stays disabled through any reconcile.
