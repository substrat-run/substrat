---
'@substrat-run/dashboard': minor
---

GitHub import acts on the team the page is showing (#2170). Connecting GitHub, the repo and branch pickers and one-click CI setup now name their team in the request (`/api/teams/:teamId/github/…`) instead of reading the selected-team cookie, which every tab shares. Before, a tab on one team whose cookie another tab had moved could connect GitHub to the other team and wire a repo's CI to push into it. The install callback takes its team from the state it signed when the connect began, and returns the tab to that team. The old cookie routes (`/api/github/connect`, `repos`, `branches`, `setup-ci`) are removed; connect now answers the install URL as JSON and the page navigates to it. The dashboard assistant is not given the GitHub reads.
