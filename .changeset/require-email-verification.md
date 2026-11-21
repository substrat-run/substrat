---
'@substrat-run/demo-auth-server': minor
'@substrat-run/demo-auth-server-app': minor
---

An Auth Server can now require a verified email address before a password signs anyone in: the new `REQUIRE_EMAIL_VERIFICATION` setting, a switch on the Username-Password connection's Settings tab, off by default. With it on, a new account is signed in by the link in its verification mail, and that link carries someone an application sent here back to that application. An unverified person who signs in with the right password is told to check their inbox and sent a fresh link.
