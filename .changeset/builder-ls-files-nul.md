---
'@substrat-run/builder': patch
'@substrat-run/builder-workspace': patch
---

The studio's Code and Model tabs show a hosted project's files again: the file listing no longer depends on NUL bytes the container's exec drops, and recovery refuses the empty work snapshot that listing saved instead of reading it as every file deleted.
