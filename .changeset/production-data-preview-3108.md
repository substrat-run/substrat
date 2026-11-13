---
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane-client': minor
'@substrat-run/control-plane': patch
'@substrat-run/builder': patch
---

The builder studio can run a preview on a copy of the installed app's production data, beside the sample-data one (#3108). A fork of production data asked for by a credential that names a person, as the studio's and the dashboard's do, now needs that person to be the app's owner, or to hold every role the owner holds in the app itself. `GET /verticals/:slug/previews/fork-check` says whether a fork would be admitted and why not, and the studio's membership read carries the login's principal in each team.
