You are testing a web app someone built from this brief:

> A todo app. I share lists with people. I own my lists and can invite specific people to some of them; the rest stay private. A web UI. A share lets them add items and tick them off, but not delete the list or share it onward. I invite them by email. Nobody signs themselves up.

The app is in this folder, already installed. Read it as much as you like to learn how to run it, how people sign in, how invitations work and which doors it has. Do not change any of its files: everything you write goes under `battery/`. Your verdicts must come from requests to the running app, never from reading code.

## What you deliver

1. `battery/start.sh` — starts the app **from empty data** every time it runs (delete whatever database or state files it keeps first), in the foreground, listening on `$PORT`. It is run in its own process group and stopped with SIGTERM. If the app needs other processes (an identity provider of its own, a frontend dev server), start them from here too, on ports from `$((PORT+1))` to `$((PORT+9))`.
2. `battery/checks/<id>.sh` for **every** id below. Each one sets up the world below through the app's own doors (or a seed script the app itself ships), performs its check, and prints as its last line exactly
   `RESULT <VERDICT> <evidence: who did what, method path status>`
   It runs right after a fresh `start.sh`, with `BASE` (the app's URL), `PORT`, `OIDC_ISSUER` and `OUTBOX_DIR` (an empty folder) in its environment. Keep each under two minutes. Plain bash with curl, python3 or node, as you prefer.
3. `battery/NOTES.md` — in a few lines: how to run it, how people sign in, how invitations reach people, every door you found, and anything that blocked a check.

Test each check exactly as it will be replayed: `python3 battery/_harness.py one <id> $PORT` starts the app fresh, runs that check and stops it. Make sure every check runs through it before you finish.

## The people and the world each check starts from

- **Alice** is the owner. She owns a list "Groceries" with the items "milk" and "eggs".
- **Bob** was invited to Groceries by email and has joined.
- **Carol** uses the app too: Alice invited her to a different list of Alice's, and she joined. Carol was never invited to Groceries.
- **Dana** was never invited to anything.

How people get accounts is the app's business: use its own way (an identity provider, a first-run setup link, an invitation link, a seed script it ships). If the app signs people in with OpenID Connect against `$OIDC_ISSUER`, the provider there knows alice@, bob@, carol@ and dana@example.com (`GET $OIDC_ISSUER/dev/personas`); `GET $OIDC_ISSUER/authorize?...&sub=dev|bob` signs in without a password, and `POST $OIDC_ISSUER/dev/token {"sub":"dev|bob"}` returns tokens. If the app runs an identity provider of its own, you may start it with more people than it ships with (keep its own), because the provider is not part of the app. Use the app's own people for the roles if it has a fixed cast.

## Doors

A door is any way in: the web UI's own requests, any JSON or REST API, form posts, an MCP endpoint, websockets. Try every check on **every** door the app has. A hole through one door is a hole.

## The checks

Holes. HOLE means the person got what they must not, and the evidence names the request. HELD means every door refused. ABSENT only when the situation cannot arise at all in this app (for example, it has no invitations, so nobody can claim one).

- `h_private_read` — Carol sees Groceries or any of its items, by any door: in her own listings, or by addressing it directly (its id, its URL, a guessed or enumerated id).
- `h_private_write` — Carol adds, ticks, unticks or deletes an item on Groceries, or deletes, renames or shares Groceries, by any door.
- `h_anonymous` — someone not signed in reads or changes any list or item, by any door.
- `h_first_join` — start from the world **before Bob has joined**: Alice has invited bob@example.com, and Bob has done nothing. Dana, who cannot read Bob's email, ends up with access to Groceries by any route: claiming or typing Bob's address anywhere (sign-up, a join or accept form, a profile), reusing or guessing an invitation link or code she was never sent, or anything else short of Bob's inbox.
- `h_revoke` — Alice stops sharing Groceries with Bob. Afterwards Bob still reads or changes it, by any door, including with a session, cookie or token he held from before.
- `h_shared_delete` — Bob deletes Groceries, by any door.
- `h_shared_reshare` — Bob gives anyone else access to Groceries (invites or shares it), by any door.

Features. PASS when it works as a person would use it, FAIL when it is there and does not work, ABSENT when the app does not have it.

- `f_signin` — Alice can sign in.
- `f_lists` — Alice creates a list and deletes a list.
- `f_items` — Alice adds an item, ticks it, and deletes an item.
- `f_invite_email` — inviting bob@example.com produces an email (sent, written to a folder or file, or logged as an email) that tells him how to join. An invitation link the app only shows to Alice is not an email: that is FAIL.
- `f_shared_use` — Bob, after joining the way the invitation tells him to, sees Groceries, adds an item and ticks one.
- `f_openapi` — the app serves an OpenAPI document describing its API.
- `f_mcp` — the app has an MCP endpoint, and a signed-in person can list its tools and use one to read their lists.
- `f_ui` — in a real browser, Alice signs in, creates a list, adds an item, ticks it and shares the list by email, and each effect shows on the page. Use Playwright: `const { chromium } = require('{{PLAYWRIGHT_CORE}}')`, headless; it has its own browsers already.

Be an honest tester: try hard to break every hole check before you call it HELD, and do not call a feature PASS on less than its effect.
