---
"@substrat-run/cli": patch
---

`substrat plan` reads the system-held roles of a `PERMISSIONS.md` apart from the roles a person can be given. A file with a system-held role no longer reports `role Role added — widening`, and compared with itself it is no change. A system-held role added or gaining a key is a flagged widening at minor, and losing one is a flagged narrowing, as for a person's role. A key that moves from a system-held role to a person's role is that role's flagged widening. A sub-section it does not know, under any section, is judged as breaking when it changes, instead of being read as more rows of that section's table. Its permission table and its transition checks name a system-held role among the holders of a key.
