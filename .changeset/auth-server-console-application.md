---
---

auth-server: the admin console is an application in the issuer's own registry. Every other
screen the issuer draws belongs to a relying party, which is what lets an operator theme it
and narrow which sign-in methods it offers — read per client id. The console's own sign-in
had no client id at all, so it was the one screen those two features could not reach. A
`console` row is now seeded on first boot in both runtimes, carrying no theme and no policy,
so a fresh install and an upgraded one draw exactly the screen they drew before. Narrowing it
decides which buttons that screen draws and nothing else — a console sign-in never passes
through `/oauth2/authorize`, where a relying party's policy is enforced — and three things
keep an operator from stranding themselves: a save that would leave no method this issuer
currently offers is refused, disabling the row falls back to the plain screen, and
`/login?builtin=0` skips it entirely. The row cannot be deleted. Both packages are private,
so nothing publishes.
