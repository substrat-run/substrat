# Security policy

## Reporting a vulnerability

**Please do not open a public issue, pull request or discussion for a vulnerability.** This
repository is public, so anything posted there is disclosure, not a report.

Report it privately through GitHub instead:

**[Report a vulnerability](https://github.com/substrat-run/substrat/security/advisories/new)**
(the repository's **Security** tab → **Report a vulnerability**).

That opens a private advisory only the maintainers and you can see. It is also where we
discuss a fix with you and, once it has shipped, publish the advisory.

Include what you can of:

- what is affected — the package and version, or the hosted surface, and the URL or
  operation involved;
- what an attacker gains: whose data or which permission is reached, and from what starting
  position (anonymous, a signed-in user of one tenant, a builder with a deployed vertical);
- steps or a proof of concept that reproduces it.

A report that is incomplete is still worth sending. We would rather have half a report now.

## What is in scope

- The code in this repository, and the `@substrat-run/*` packages published from it.
- The hosted platform on `substrat.net` and `substrat.run` — the control plane, dashboard,
  router, builder, and the host a deployed vertical runs on.

The findings we care about most are the ones the platform exists to prevent: **crossing a
tenant boundary**, reaching a scope's data other than through the kernel, **bypassing a
permission check**, forging or altering the audit spine, and escaping the sandbox a vertical
runs in.

A vertical is the business logic someone built *on* Substrat. A flaw in a specific vertical's
own screens or rules belongs with whoever runs that vertical — unless it exists because the
platform let it, in which case it belongs here.

Please test against a tenant you own, do not read or change data that is not yours, and stop
once you have shown the issue exists. No load or denial-of-service testing against the
hosted platform.

## Supported versions

Substrat is pre-1.0. Security fixes are made on `main` and released as a **new version of the
affected package**; they are not backported to older releases. Only the latest published
release of each `@substrat-run/*` package is supported, and the packages that share a
version line (`contracts`, `kernel`, `adapter-sqlite`, `adapter-cloudflare`, `contract-tests`,
`control-plane-api`, `vertical-host`) move together, so upgrade them as a set.

The hosted platform is always running the current code.

## What to expect back

- **Acknowledgement** — we aim to reply within 5 working days, saying whether we can
  reproduce it and who is looking at it.
- **Updates** — we will tell you when it is confirmed or ruled out, and again when a fix is
  merged. If a report is not a vulnerability, we will say why.
- **Disclosure** — once a fix is released we publish a GitHub security advisory (with a CVE
  where one applies) and credit you, unless you prefer not to be named. We would like to
  agree the timing with you first, and ask that you do not disclose publicly before then.

This policy makes no promise about how long a fix takes: that depends on the finding.
