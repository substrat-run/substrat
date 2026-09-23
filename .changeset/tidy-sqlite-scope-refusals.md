---
"@substrat-run/adapter-sqlite": patch
---

Return typed `not_found` errors for missing or foreign-tenant scopes across the SQLite adapter's remaining scope guards, preserving existing messages and validation order.
