---
'@substrat-run/kernel': minor
'@substrat-run/attachment-extractors': patch
---

The HTML extractor now ends every construct where a browser's HTML tokenizer ends it. A `script` or `style` element closes only at a complete end tag of its own name, so a string such as `"</scripture>"` inside a script no longer ends it early and lets the rest of the script be indexed as text. Script escape rules, nested `template` content, a `>` inside a quoted attribute value and the ways a comment can end follow the tokenizer too.

The bundled parsers check the kernel's abort signal at least every `EXTRACTION_STRIDE` units of work, inside a single long comment, tag or run of text as well as between them, and yield with `setImmediate` where the runtime has it. The kernel exports `EXTRACTION_STRIDE` (256 Ki), the interval a cooperative extractor checks its signal at.
