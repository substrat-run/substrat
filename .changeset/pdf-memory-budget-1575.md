---
'@substrat-run/attachment-extractors': patch
---

The PDF extractor holds memory to a budget, as it already held time to one (#1575). One extraction may keep at most twice its inflate budget plus 4 MiB, which is 36 MiB at the defaults. Each allocation that grows with the input is charged before it is made: cached decoded streams, a page's joined content, parsed objects, cross-reference entries, CMap entries and font decoders. If reading pages would go past the budget, the text read so far is kept and marked truncated; going past it earlier fails the file with that reason. A CMap `bfrange` is now stored as one entry, and each destination is computed when its code is looked up, instead of one string per code. A ToUnicode CMap shared by several fonts is parsed once.
