---
'@substrat-run/docs': patch
---

The book's diagrams are now in the EPUB. Five chapters draw a figure — the three-layer
stack, the tenancy tree, the adapter-neutral topology, a permission's route to
`ctx.check`, and the line an agent writes above — and `/book.epub` used to replace each
one with a paragraph describing it. That is the right answer for a machine reading
`llms.txt` and the wrong one for a person holding a phone, where the shape is supposed to
arrive before the sentence.

They are the same figures the web page draws, not redrawings of them: the components are
rendered from source when the site builds, so a diagram cannot say one thing on
substrat.net and another in Apple Books. `/book.txt` still carries the prose, because a
file meant for `pandoc` and for models wants words.
