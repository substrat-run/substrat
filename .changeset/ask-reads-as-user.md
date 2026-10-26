---
'@substrat-run/dashboard': minor
'@substrat-run/vertical-host': patch
---

Ask reads everything the person asking can read (#2283). Every declared GET route of the dashboard is now a tool, called through the route's own handler as the caller, so the assistant has exactly the person's access: the team's apps and activity, members and invites, the audit log, domains, observability metrics, traffic, logs and requests, deployments, releases, failures and previews, findings and rules, plus each app's process map and a finding's evidence. Only reads: a test pins that no write route is offered. Tool outputs are redacted where they are free text (a member's address in the roster is kept, an address inside a log line is not), cut to fit the protocol's bound with `truncated: true`, and a question may take up to six model calls. vertical-host: a run's steps now report each tool call that failed (`toolErrors`), so a host can show why.
