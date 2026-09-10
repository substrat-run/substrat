---
'@substrat-run/demo-auth-server': patch
---

An administrator can take one sign-in method away (part of #1278).

The user-detail screen could already answer "how does this person sign in" for somebody
else — that read was the one server surface the screen needed — but it could only read.
An operator holding "this Google account is not theirs any more" had no lever, because
Better Auth's `unlink-account`, like its `list-accounts`, answers only for the session
making the call.

`DELETE /api/admin/users/:userId/sign-in-methods/:accountId` is that lever, behind the
same session + `admin` gate as its neighbours, with two refusals that are the point of
it rather than validation around it. The row must belong to the user the URL names —
`account.id` is globally unique, so a delete keyed on the id alone would unlink a
different person's method through a URL naming the one an operator was looking at. And
it must not be their last way in: an account with no method is not a lesser account, it
is one nobody can sign into, recoverable only by an administrator setting a password and
not at all by the person themselves. A `credential` row counts only when it actually
carries a hash, which is a distinction the browser cannot make and so belongs here.

On screen each row gets a Remove button whose confirmation names the consequence rather
than the verb, and says the thing most likely to be assumed the other way: removing a
method decides how they sign in next time, and leaves the sessions they already have
open. Ending those is Revoke, one panel below, and doing both from one button would take
the choice away. The last remaining method's button is disabled with the reason written
out beside it — the server refuses it either way, and meeting that refusal as an error
banner is a worse way to learn it.

The password hash and the upstream's tokens still never leave the server: the row that
decides is read as a predicate (`password IS NOT NULL`), never as a value.

No migration and no permission key. `impersonate-user` stays mounted and unused — that
is a separate decision #1278 asks to be argued rather than taken in passing.
