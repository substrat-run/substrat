---
'@substrat-run/demo-auth-server': minor
---

Connect a second way of signing in to the account you already have. Someone who
signs up with a password and later clicks "Continue with <provider>" hits Better
Auth's `account not linked` — a correct refusal, since an address at an upstream
is not by itself permission to become whoever holds it here, but until now a dead
end with nothing on the screen to do about it. The dashboard now lists the sign-in
methods on your own account and connects or disconnects one from inside a session
that already proves who you are, which is the path that works for an account no
upstream has verified — one an administrator created, or one BankID minted. The
"not an administrator" page carries the same panel: it is the only page an ordinary
person of this issuer ever reaches, and it is exactly where the refusal sends them.
The admin's `trust_email` toggle stays the other way past, and the new suite pins
what separates them — trusting a provider joins at sign-in only when the local row
is verified too — plus the property that makes either worth having: after a link,
signing in through the upstream returns the same user id, the `sub` every relying
party already stored.
