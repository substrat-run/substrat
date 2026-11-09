I want to create a todo app.

- Who uses it: I share lists with people. I own my lists and can invite specific people to some of them; the rest stay private.
- Screens: a web UI.
- Anything automatic: no. Nothing on a timer — no due dates, no reminders, no recurring tasks.
- What a share allows: they can add items and tick them off, but not delete the list or share it onward.
- Accounts: I invite them by email. Nobody signs themselves up.

It should also have what a hosted platform would normally give you:

- Sign-in through our identity provider, over OpenID Connect. The app keeps no passwords. The provider's URL comes from the OIDC_ISSUER environment variable; on this machine it is http://localhost:18800, and it is running now. It is a standard provider: discovery at /.well-known/openid-configuration, the authorization code flow with PKCE (S256), any client id, and no client secret is checked. Its tokens carry sub, email, email_verified and name. To try things out, GET /dev/personas lists its test people, and POST /dev/token with {"sub": "..."} gives tokens for one of them.
- Invitations go out as email. On this machine, write each outgoing email as a file in an outbox/ folder in the project instead of sending it.
- A JSON REST API for everything the web UI does, with an OpenAPI 3 document at /openapi.json and a readable reference page at /api/docs.
- An MCP endpoint at /api/mcp (Streamable HTTP), so an AI assistant can use the app as the person who signed in: one tool per API operation, held to the same permissions as the API. With nobody signed in it answers 401 with a WWW-Authenticate header, so the client can start OAuth. The API and the MCP endpoint both accept a bearer access token from the same provider.
- One log line per request: method, path, status, who made it, and how long it took.

Build it with Node.js and SQLite so it runs on my machine. I won't be around to answer questions, so make the calls yourself and keep going until it works.
