---
'@substrat-run/contracts': minor
'@substrat-run/cli': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
---

The provisioner capability gains its request half (#455): a manager vertical DECLARES the
target verticals it provisions — package.json `substrat.provisions`, carried on push to
the registry row (`vertical.provisions`, riding the refreshable install_spec bag) — and
the console reviews the declaration like a publish request (declared-but-ungranted shows
as *provisioner requested*; the grant button reads *Approve provisioner*). Declaration is
a request, never a grant: `tenantProvisioner` stays the staff-flipped flag a push cannot
touch (contract-tested both ways). The drain's `admitManager` now distinguishes
*undeclared* (fix your manifest) from *declared-but-ungranted* (awaiting staff) in its
refusal, and — #412 invariant 4 — bounds a granted manager's `provision-tenant` to its
declared targets, phased: a granted manager that declares nothing keeps its pre-#455
unbounded behavior until its next push declares.
