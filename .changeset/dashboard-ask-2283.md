---
'@substrat-run/dashboard': minor
---

Ask in the ⌘K overlay (#2283). Where AI explanations are offered, the overlay has a third mode, **Ask**: a question about the team's apps, answered by a model that reads through the dashboard's own guarded reads (the team's apps, its findings, one finding's evidence) as the person asking, and only reads. Each answer carries the AI marker, the reads it made and when it was written; follow-ups carry the conversation so far, which lives in the browser until threads are recorded. The route (`POST /api/teams/{teamId}/assistant/ask`) answers in the assistant's stream protocol, so the overlay is a protocol client. A question takes one unit of the same daily budget as explanations, a spent budget ends the turn on a budget notice before any model call, and a failed model call ends it on an error the person can read and still counts.
