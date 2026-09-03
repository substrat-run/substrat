---
'@substrat-run/boundary-lint': patch
---

`cimd-fetch.ts` joins the default harness list, beside the other `auth*.ts` entries it is
imported by.

R3 bans `fetch` in module code because a module's capabilities come from `ctx`, and a
vertical that needs the outside world reaches it through a connector. An issuer resolving a
Client ID Metadata Document has neither: the client's `client_id` IS an HTTPS URL, and
fetching the document at it is what the OAuth draft defines that identifier to mean. The
file is the auth adapter's network boundary, sits beside `auth-do.ts` and `auth-schema.ts`,
and is reachable from no `ModuleRegistration`.

This matters to a scaffolded project the same way `config-do.ts` did: the list is literal, so
a name missing from it is a new project failing its own gate on a file the template told it
to write.
