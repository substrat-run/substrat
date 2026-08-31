---
'@substrat-run/control-plane-api': minor
'@substrat-run/cli': patch
---

A masked scope export is now **pseudonymized** rather than blanked. Every PII cell used
to become the literal `[masked]`, which made a pulled scope structurally valid and
factually useless — every screen read `[masked]`, so nobody could drive a preview, a demo
or a local repro from one. Now a cell whose column name the PII heuristic *recognises*
gets a deterministic fake value of the right kind: an email at a reserved domain, a name,
a phone or postal code that keeps its country code and its digit-and-letter layout. The
same real value reads the same everywhere in one export — its own row, every event
payload that quoted it, the timeline — so joins and screens line up. A column the
heuristic does not recognise is untouched, which is why the file is still personal data.

Free text and national identifiers still read `[masked]`: a hash cannot invent a
sentence, and a generated personnummer may belong to a real person. This is
pseudonymization, not anonymization — the pull stays staff-only, audited and
jurisdiction-gated, and the CLI now says so.

`maskSalt` on `createControlPlaneApi` keys the generator; absent, each export gets a
fresh random salt (still stable within one response, uncorrelated across two).
