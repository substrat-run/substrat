I want a CRM for my sales team.

- **Who uses it:** my sales team. I run sales, I have two sales managers, and each of them has a few reps. We'd also like to offer it to a partner company: each company gets its own space with its own people and data, and must never see the other's.
- **Teams and roles:** in each company there's an admin (me, in ours), managers, and reps. Each manager leads one team, and each rep belongs to one team.
- **Accounts:** the admin invites people by email and chooses their role and team. Nobody signs themselves up.
- **What we keep track of:** the companies we sell to, the people at them (contacts), the deals we're working on, and notes on any of those: calls, meetings, emails we want to remember.
- **Deals:** a deal belongs to a company, has an owner (a rep), a value and a currency (we sell in SEK and EUR), and moves through stages: lead, qualified, proposal, then won or lost. Once a deal is won or lost it's locked; only a manager can reopen it.
- **Who sees what:** companies and contacts are shared by everyone in our company. Deals are not: a rep sees the deals they own and the ones a colleague has shared with them; a manager sees every deal in their team; the admin sees everything and can hand a deal to another rep. Notes on a deal follow the deal.
- **History:** on a deal I want to see who changed what and when (the stage, the value, the owner). Nobody can edit or delete that history.
- **Report:** one report, the pipeline: the total value of open deals per stage, for the deals you're allowed to see. Show each currency on its own; don't convert.
- **Search:** one search box that finds companies, contacts and deals, as long as you're allowed to see them.
- **Import and export:** I want to bring our contacts in from a spreadsheet (a CSV file) and export them to one again.
- **Personal data:** if a contact asks us to forget them, the admin can erase them. Their details have to be gone everywhere, but we keep a note that we erased someone, and when.
- **Screens:** a web UI.
- **Anything automatic:** no. No email syncing, no reminders, no automations.

It should also have what a hosted platform would normally give you:

- Sign-in through our identity provider, over OpenID Connect. The app keeps no passwords. The provider's URL comes from the OIDC_ISSUER environment variable; on this machine it is http://localhost:18800, and it is running now. It is a standard provider: discovery at /.well-known/openid-configuration, the authorization code flow with PKCE (S256), any client id, and no client secret is checked. Its tokens carry sub, email, email_verified and name. To try things out, GET /dev/personas lists its test people, and POST /dev/token with {"sub": "..."} gives tokens for one of them.
- Invitations go out as email. On this machine, write each outgoing email as a file in an outbox/ folder in the project instead of sending it.
- A JSON REST API for everything the web UI does, with an OpenAPI 3 document at /openapi.json and a readable reference page at /api/docs.
- An MCP endpoint at /api/mcp (Streamable HTTP), so an AI assistant can use the app as the person who signed in: one tool per API operation, held to the same permissions as the API. With nobody signed in it answers 401 with a WWW-Authenticate header, so the client can start OAuth. The API and the MCP endpoint both accept a bearer access token from the same provider.
- One log line per request: method, path, status, who made it, and how long it took.

Build it with Node.js and SQLite so it runs on my machine. I won't be around to answer questions, so make the calls yourself and keep going until it works.
