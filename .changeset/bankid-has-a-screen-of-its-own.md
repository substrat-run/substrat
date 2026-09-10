---
'@substrat-run/demo-auth-server': patch
---

BankID's certificate form is a screen with a URL (part of #1278).

The last configuration surface in the issuer console that was still edited inline: an
mTLS certificate, a private key, an environment and two decisions, in a form that
unfolded under the status table with no address of its own. So a reload lost whatever
had been pasted, a stale session's sign-in landed the operator back on the status table,
and the screen could not be sent to anyone.

`/bankid` is now the status — environment, whether a certificate is stored, enabled or
disabled, and what an operator can do next — and `/bankid/settings` is the certificate,
the environment and an Actions panel holding the removal. `returnTarget` keeps the
second one across the sign-in it triggers, so a pasted link survives the login it
provokes, the same way the Users, Applications and Sign-in-provider detail screens do.

It is the one detail screen with nothing to identify: there is a single BankID
configuration per issuer, no client id and no redirect URI to register, so the segment
is a literal rather than an id — and, unlike the other three, the path is a place
whether or not anything is configured there yet. Enabling BankID and editing it are the
same screen, which is why the status table's button is a link.

No server surface, no migration and no permission key: `GET /api/admin/bankid` already
returned every fact both screens show.
