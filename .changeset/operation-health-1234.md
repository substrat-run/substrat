---
'@substrat-run/dashboard': patch
---

An app's operations get their own panel: what each one has recorded, when it last ran, and how often it was refused.

The refusal half is the useful surprise. Permission refusals have been recorded against each operation since the platform started keeping them, and nothing on the customer side has ever shown them — so an operation somebody keeps calling and keeps being refused was, until now, completely silent. It appears here even if it has never successfully done anything, which is exactly the case a panel built only from successes would miss.

Two limits are stated on the panel rather than left to be assumed, because both invite a wrong reading. An operation that raises no events does not appear at all, however often it runs: this counts events, not calls. And refusals are counted over what the refusal log still holds, which is a storage limit rather than a promise to keep them — so no refusals showing does not mean an operation has never been refused, and the panel says from when it can vouch for.

There is deliberately no timing here. Per-operation duration is not something the platform records, and a column of plausible-looking numbers would be worse than the absence.
