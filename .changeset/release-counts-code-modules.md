---
'@substrat-run/contracts': minor
'@substrat-run/cli': patch
---

A store-driver release counts only code toward its 1000-module limit (D-68): a file Python can import or load (`.py`, `.pyc`, `.so`, also a versioned `.so.1.2`), by the new `isPythonCodeModule`. A data file beside it, such as a time zone file, counts toward the 10 MiB byte limit and the new 4000-file limit (`STORE_RELEASE_MAX_FILES`) only, and the module rule still judges its name. `substrat store-driver upload` counts the same way when it walks the release, and stops at the byte limit as soon as it is passed.
