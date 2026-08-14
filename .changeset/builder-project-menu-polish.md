---
"@substrat-run/builder": patch
---

Studio project-menu polish: the project dropdown now closes on outside click and Escape (document-level pointerdown/keydown listeners scoped to while it is open), and "New project" opens a styled modal — the model-picker shell sized down to a single input with Cancel/Create — instead of the browser-native `window.prompt()`. Enter creates, Escape or backdrop click cancels, and an empty name still lets the AI name the project at concept time.
