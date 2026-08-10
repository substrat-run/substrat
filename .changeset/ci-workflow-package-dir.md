---
"@substrat-run/contracts": minor
"@substrat-run/cli": minor
"@substrat-run/dashboard": minor
"@substrat-run/dashboard-web": minor
---

feat(contracts,cli,dashboard): the deploy workflow learns a package directory — monorepos connect nested verticals

The generated GitHub workflow assumed the vertical is the repo root: install at
root, `push .`, version gates on the root package.json. `DeployWorkflowOptions`
gains `path` — pushes and previews build that directory, both version gates read
ITS package.json, and the triggers gain an editable `paths:` filter so an
unrelated merge does not deploy the package. Threaded through all three writers:
`substrat init --ci github --path <dir>`, the dashboard's setup-ci and
workflow-preview endpoints (the slug now derives from the directory basename,
not the repo name), and a directory field in the connect form. Root spellings
collapse to the pathless file; traversal is refused in the generator. The CLI's
top-level errors now carry an `error:` prefix so a failure is not read as more
wrangler chatter.
