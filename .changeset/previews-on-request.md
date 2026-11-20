---
'@substrat-run/contracts': minor
'@substrat-run/cli': minor
'@substrat-run/dashboard': patch
'@substrat-run/dashboard-web': patch
'@substrat-run/docs': patch
---

Pull request previews can be opt-in. The generated deploy workflow takes `previews: 'on-request'`, which previews only a PR labelled `preview`, and contracts adds the "No preview yet" comment it pairs with. `substrat init --ci github --previews on-request` writes it. In the dashboard, a repo set up for the first time previews on request: each new PR's comment links to a Build preview page that labels the PR through the GitHub App. Two kinds of repo keep previewing every PR: one linked before this change, and one whose deploy workflow was already committed when it is set up (by hand, or before repo links existed). The setup card's Preview every PR switches between the two.
