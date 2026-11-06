---
"@substrat-run/builder": minor
"@substrat-run/builder-generator": minor
"@substrat-run/builder-workspace": minor
---

A hosted build's work now reaches the browser as it is written, and survives a container lost mid-turn: the working tree is saved after each pass and every 30 seconds during one, and restored if the sandbox comes back empty. The studio opens the Model tab when the model is ready, and a project's sandbox sleeps after 30 idle minutes rather than 10.
