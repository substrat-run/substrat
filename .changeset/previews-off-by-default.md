---
'@substrat-run/contracts': minor
'@substrat-run/cli': minor
'@substrat-run/dashboard': patch
'@substrat-run/dashboard-web': patch
'@substrat-run/docs': patch
---

Pull request previews are on request by default. Each preview forks prod's data, which is billed per row written, so previewing every push to every PR is now something a repo asks for. The generated deploy workflow defaults to `previews: 'on-request'`, and `substrat init --ci github` writes it unless you pass `--previews every-pr`. In the dashboard, setting up a repo commits the on-request workflow unless Preview every PR is ticked. That now includes a repo whose workflow was already committed, and one linked before the choice existed. Only a repo where somebody chose every PR on an earlier run keeps it. A workflow already committed keeps previewing every PR until its deployment is updated.
