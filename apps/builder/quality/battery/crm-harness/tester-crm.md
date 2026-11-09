You are testing a web app someone built from this brief:

> A CRM for a sales team. In each company there's an admin, managers and reps; each manager leads one team and each rep belongs to one team. A partner company gets its own space with its own people and data, and must never see ours. The admin invites people by email and chooses their role and team; nobody signs themselves up. We keep companies, the people at them (contacts), deals, and notes on any of those. A deal belongs to a company, has an owner (a rep), a value and a currency (SEK or EUR), and moves through stages: lead, qualified, proposal, then won or lost. Once won or lost it is locked; only a manager can reopen it. Companies and contacts are shared by everyone in the company. A rep sees the deals they own and the ones a colleague shared with them; a manager sees every deal in their team; the admin sees everything and can hand a deal to another rep. Notes on a deal follow the deal. Each deal has a history of who changed its stage, value or owner and when, which nobody can edit or delete. One report: the total value of open deals per stage, for the deals you may see, each currency on its own. One search box over companies, contacts and deals you may see. Contacts can be imported from and exported to CSV. The admin can erase a contact who asks to be forgotten: their details gone everywhere, with a note kept that someone was erased, and when. A web UI. Nothing automatic.

The app is in this folder, already installed. Read it as much as you like to learn how to run it, how people sign in, how companies, invitations and roles work, and which doors it has. Do not change any of its files: everything you write goes under `battery/`. Your verdicts must come from requests to the running app, never from reading code.

## What you deliver

1. `battery/start.sh` — starts the app **from empty data** every time it runs (delete whatever database or state files it keeps first), in the foreground, listening on `$PORT`. It is run in its own process group and stopped with SIGTERM. If the app needs other processes (an identity provider of its own, a frontend dev server), start them from here too, on ports from `$((PORT+1))` to `$((PORT+9))`.
2. `battery/checks/<id>.sh` for **every** id below. Each one sets up the world below through the app's own doors (or a seed script the app itself ships), performs its check, and prints as its last line exactly
   `RESULT <VERDICT> <evidence: who did what, method path status>`
   It runs right after a fresh `start.sh`, with `BASE` (the app's URL), `PORT`, `OIDC_ISSUER` and `OUTBOX_DIR` (an empty folder) in its environment. Keep each under four minutes; build the world once in a shared helper and reuse it.
3. `battery/NOTES.md` — in a few lines: how to run it, how people sign in, how companies, invitations and roles reach people, every door you found, and anything that blocked a check.

Test each check exactly as it will be replayed: `python3 battery/_harness.py one <id> $PORT` starts the app fresh, runs that check and stops it. Make sure every check runs through it before you finish.

## The people and the world each check starts from

Two companies. **Acme** is ours; **Birch** is the partner.

- Acme: **Alice** is the admin. **Mia** manages team North, where **Rob** and **Rita** are reps. **Max** manages team South, where **Sam** is a rep.
- Birch: **Bea** is the admin; **Ben** is a rep.
- Acme's records: customer companies **Fjord AB** and **Lake Oy**; contacts **Pia Persson** (pia@fjord.example, +46 70 111 22 33) at Fjord AB and **Lars Lind** at Lake Oy.
- Acme's deals:
  - **D1** "Fjord renewal": Fjord AB, owner Rob, 120000.50 SEK, stage proposal, with a note by Rob. Rob has shared D1 with Sam.
  - **D2** "Lake pilot": Lake Oy, owner Rita, 30000 EUR, stage qualified. Shared with nobody.
  - **D3** "Fjord upsell": Fjord AB, owner Sam, 50000 SEK, stage lead.
  - **D4** "Fjord expansion": Fjord AB, owner Rob, 80000 SEK, won (so locked).
- Birch's records: customer **Oak Ltd**, contact **Olle Ek**, and a deal "Oak deal" owned by Ben, 9999 EUR, stage lead.
- Alice has invited **Nora** (nora@example.com) as a rep in North; Nora has not joined yet.
- **Dana** was never invited to anything.

How people and companies come to exist is the app's business: use its own way (an identity provider, a setup command, an invitation, a seed script it ships). If the app signs people in with OpenID Connect against `$OIDC_ISSUER`, the provider there knows all ten of these people (`GET $OIDC_ISSUER/dev/personas`); `GET $OIDC_ISSUER/authorize?...&sub=dev|rob` signs in without a password, and `POST $OIDC_ISSUER/dev/token {"sub":"dev|rob"}` returns tokens. If the app runs an identity provider of its own, you may start it with more people than it ships with (keep its own), because the provider is not part of the app. Use the app's own people for the roles if it has a fixed cast.

## Doors

A door is any way in: the web UI's own requests, any JSON or REST API, form posts, an MCP endpoint, websockets, search, the report, import and export. Try every check on **every** door the app has. A hole through one door is a hole.

## The checks

Holes. HOLE means the person got what they must not, and the evidence names the request. HELD means every door refused. ABSENT only when the situation cannot arise at all in this app (for example, it cannot hold two companies, so nothing can cross between them).

- `h_cross_company` — Bea or Ben sees or changes anything of Acme's (a company, contact, deal, note, history entry, a report figure, a search hit, an export row, or a record imported into Acme), or anyone at Acme sees or changes anything of Birch's, by any door.
- `h_rep_visibility` — Rita sees D1 or D3, or their value, notes or history, by any door: her listings, a direct id, search, export, or a report total that includes them.
- `h_manager_scope` — Max sees D2, or its value, notes or history, by any door, including search and a report total that includes it.
- `h_rep_writes` — Rita changes D1 (stage, value, owner, a note, or deletes it), or anyone but Alice hands a deal to another rep, by any door.
- `h_locked_deal` — anyone but Mia or Alice changes D4's stage, value or owner, or reopens it, by any door. Rob, its owner, included.
- `h_history` — anyone edits or deletes a history entry, or a change to a deal's stage, value or owner through some door leaves no history entry.
- `h_role_escalation` — someone who is not the admin invites a person, changes anyone's role or team, erases a contact, or makes themselves a manager or admin, by any door.
- `h_erasure` — after Alice erases Pia, Pia's email or phone can still be found by any door, or her name still appears on a contact record, a search result, an export, or anything attached to her contact. Text someone typed into a note on another record does not count.
- `h_import` — a CSV import by Rob creates or changes anything in Birch, or anything he could not create or change by hand; or an import by Dana, or by someone not signed in, does anything at all.
- `h_export_formula` — a contact named `=HYPERLINK("http://example.net","x")` (or any field starting with `=`, `+`, `-` or `@`) is exported into a CSV cell that a spreadsheet would run as a formula.
- `h_anonymous` — someone not signed in reads or changes anything, by any door.
- `h_first_join` — before Nora has joined, Dana (or anyone but Nora) ends up with Nora's invitation, or anything it grants, by any route short of Nora's inbox: claiming or typing Nora's address anywhere, reusing or guessing an invitation link or code, or anything else.
- `h_revoke` — Rob stops sharing D1 with Sam. Afterwards Sam still sees or changes D1, by any door, including with a session, cookie or token he held from before.

Features. PASS when it works as a person would use it, FAIL when it is there and does not work, ABSENT when the app does not have it.

- `f_signin` — Alice can sign in.
- `f_two_companies` — Birch exists beside Acme, with its own admin and its own records, through the app's own way of adding a company. Not possible at all is FAIL.
- `f_invite_email` — inviting nora@example.com produces an email (sent, written to a folder or file, or logged as an email) that tells her how to join. An invitation link the app only shows to the admin is not an email: that is FAIL.
- `f_join` — Nora joins the way the invitation tells her to, and lands as a rep in North: she sees the shared companies and contacts and none of D1 to D4.
- `f_records` — Rob creates and edits a company and a contact, and Sam sees both.
- `f_deal_stages` — Rob creates a deal and moves it from lead through qualified and proposal to won; it is then locked; Mia reopens it.
- `f_visibility` — Rita sees D2; Sam sees D1 and D3; Mia sees D1, D2 and D4; Max sees D3; Alice sees all four.
- `f_history` — after Rob changes D1's value and Mia changes its stage, D1's history shows who changed what, and when.
- `f_report` — Alice's report shows exactly 120000.50 SEK in proposal, 30000.00 EUR in qualified and 50000.00 SEK in lead (any formatting of the same amounts), with the won deal outside the open pipeline or shown apart.
- `f_search` — Alice searching "Fjord" finds Fjord AB, D1, D3 and D4; searching "Pia" finds her contact.
- `f_import_export` — importing a CSV with two new contacts adds them, and an export contains them.
- `f_erasure` — Alice erases Pia: she is gone from the contacts, and a record that an erasure happened, and when, remains.
- `f_openapi` — the app serves an OpenAPI document describing its API.
- `f_mcp` — the app has an MCP endpoint, and a signed-in person can list its tools and use one to read their deals.
- `f_ui` — in a real browser, Alice signs in, creates a deal, moves it to qualified and opens the report, and each effect shows on the page. Use Playwright: `const { chromium } = require('{{PLAYWRIGHT_CORE}}')`, headless; it has its own browsers already.

Be an honest tester: try hard to break every hole check before you call it HELD, and do not call a feature PASS on less than its effect.
