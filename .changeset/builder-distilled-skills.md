---
"@substrat-run/builder": patch
---

Builder-distilled skills (D-54): the generator now loads `apps/builder/skills/{interview,build}.md` instead of the repo's Claude Code skills — 15.3k chars vs 39.8k (interview turns carry 7.4k instead of 22.7k). Beyond size, the originals were wrong for the sandbox: they pointed at files a project-rooted workspace cannot read (`demos/callout/…`, `CLAUDE.md`), instructed denied tools (deploy CLI, curl), contradicted the one-question-at-a-time interview, and duplicated the system prompt's module rules. The distilled pair carries the engine coverage map (now including engine-absence and engine-metering) + concept template, and inline verified code shapes replacing the unreachable reference files.
