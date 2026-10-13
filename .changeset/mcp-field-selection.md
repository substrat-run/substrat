---
'@substrat-run/vertical-host': minor
---

Smaller MCP tool results. A result is now sent once, as compact JSON in the text block, where it used to be sent twice (a text block and `structuredContent`) and indented. A read whose output names its columns also takes an optional `fields` argument that keeps only those columns of each entry; an unknown name is refused in-band with the valid ones listed.
