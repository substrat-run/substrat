---
'@substrat-run/docs': patch
---

The EPUB edition of the book now opens. `/book.epub` shipped with ten invalid identifiers
in its package document — a manifest id may not begin with a digit, and ten of the eleven
chapters are numbered — so the file failed to parse and Apple Books declined it without
saying why. It is now clean against the EPUB 3.3 rules, and the contents page no longer
prints every chapter number twice.
