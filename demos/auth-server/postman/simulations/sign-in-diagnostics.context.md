# Sign-in diagnostics

Synthetic GitHub fixtures, checked 2026-10-28. The mock was built from GitHub's
[email endpoint contract](https://docs.github.com/en/rest/users/emails#list-email-addresses-for-the-authenticated-user)
and the installed Better Auth adapter; no owner mock or production account was used.

## Purpose

Exercise the real auth callback against GitHub token, profile and email endpoints over HTTP.
`../mocks/github/handler.cjs` defines the fixture cases; the regression suite selects them
through synthetic authorization codes. This covers diagnostics, not live GitHub authorization.

## Execution

Run from the repository root:

```sh
postman simulation run demos/auth-server/postman/simulations/sign-in-diagnostics.sim.yaml --port 4917 --no-history --output ndjson
```

In a second terminal:

```sh
AUTH_DIAGNOSTICS_SIMULATION_URL=http://localhost:4917/github NODE_OPTIONS="$(node tools/vitest/node-options.mjs)" pnpm --filter @substrat-run/demo-auth-server exec vitest run test/github-sign-in-log.test.ts
```

Check the simulation's request events for token, profile and email traffic; stop it with Ctrl-C.
Without the URL override, the same suite starts the fixture on a temporary local port.

## Assumptions

- The test runner must be permitted to connect to localhost. The default fixture also needs
  permission to listen there. (observed 2026-10-28)
- Fixture responses model documented API shapes; actual GitHub App permissions, consent,
  rate limits and network timing still require live verification. (reasoned 2026-10-28)

## Observations

<!-- begin:observations -->
2026-10-28: all seven callback tests passed against the simulation. The GitHub member served
token, profile and email requests, including 401/403 email reads and successful empty lists;
no member was silent. Private-email sign-in succeeded with no diagnostic follow-up request.
<!-- end:observations -->

## What didn't work

- 2026-10-28: the first simulation run selected the success fixture for every code because
  `interceptRequests` consumes the body stream. The handler now reads `req.body` when supplied
  and rejects unknown fixture codes; the rerun passed.
