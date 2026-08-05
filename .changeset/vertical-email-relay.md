---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/adapter-email': minor
'@substrat-run/cli': minor
---

Give hosted verticals a sanctioned way to send transactional mail — the resolution of the
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
  re-derives *which* vertical is calling from the named `(tenant, scope)` and checks the grant
  against that. Holding the shared `PLATFORM_SECRET` (injected into every dispatch script, and
  the relay's auth) is not enough. The control plane's own origin is injected into every vertical
  as `CONTROL_PLANE_URL` so it knows where to POST.

`HostAdmin` gains `setVerticalEmailSender`; both adapters persist a nullable `email_sender`
directory column (a directory schema change, not a module migration). The auth-server demo
declares `sendsEmail` and uses the relay transport when hosted, so its Better-Auth
`sendResetPassword` flow finally delivers on a dispatch install. Everything is additive — every
existing manifest, registry row, and `HostAdmin` call site keeps compiling.
