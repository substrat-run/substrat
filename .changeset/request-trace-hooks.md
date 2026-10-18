---
"@substrat-run/adapter-sqlite": minor
"@substrat-run/vertical-host": minor
---

A request can be traced. When a trace sink is installed (the `substrat.trace-sink` slot on `globalThis`; nothing installs one yet), `SqliteScopeHost` hands it each permission check, SQL statement, emitted event, `ctx.log` line, input-validation failure and the error that ended the call, and `invocationLog` hands it the HTTP half and the outbound calls. A refused check says why: the roles that hold the permission and the roles the caller has. SQL is recorded with its parameters, minted secrets withheld; an event is recorded by type and entity, never its payload. With no sink installed, nothing is recorded and nothing changes. A sink that throws never fails a request. The platform entry is re-emitted for the new hook.
