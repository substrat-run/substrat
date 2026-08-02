---
'@substrat-run/cli': patch
---

Two deploy-session papercuts named instead of swallowed (#387). A control-plane URL
pointing at the console SPA instead of its `/api` base used to kill every command with
`Unexpected token '<' … is not valid JSON`; each control-plane response now parses
through one helper that, on an HTML body, names the URL it hit and the likely fix
(`--cp` / `SUBSTRAT_CP_URL` / `substrat login`). And a stray `SUBSTRAT_SERVICE_TOKEN`
no longer shadows a fresh login silently: the CLI warns when the env var overrides a
stored session (and when its value is an obvious copy-paste placeholder), while auth
precedence stays exactly as it was — CI relying on the env var is untouched.
