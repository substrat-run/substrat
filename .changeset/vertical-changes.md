---
"@substrat-run/contracts": minor
"@substrat-run/control-plane-api": minor
"@substrat-run/control-plane-client": minor
"@substrat-run/cli": minor
"@substrat-run/builder": patch
---

`substrat changes` lists a vertical's open changes, whichever provider holds them: its GitHub pull requests, or a studio project's chat branches, each with its checks and its preview (`GET /verticals/:slug/changes`, for a builder and the dashboard's team credential alike). A repository that cannot be read answers why instead of failing, and checks the GitHub App may not read show as `unknown` with the reason.
