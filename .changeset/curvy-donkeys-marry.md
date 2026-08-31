---
'@substrat-run/contracts': patch
---

The GitHub Actions workflow `substrat init --ci github` writes now pins
`actions/checkout@v7` and `actions/setup-node@v6` instead of the `@v4` of both.
A newly scaffolded project no longer arrives with a workflow built on action
majors that run on a retired runner image.
