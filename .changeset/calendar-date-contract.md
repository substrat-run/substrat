---
'@substrat-run/contracts': minor
'@substrat-run/engine-absence': patch
---

`calendarDate` joins `instant` in `@substrat-run/contracts` as the other half of the platform's time contract (#117): a `YYYY-MM-DD` day with no time and no zone, checked for a real month and day, unbranded so an engine can adopt it for a field it already exposes without changing any caller's type. engine-absence's `isoDate` is now that schema, which tightens its date inputs from a shape regex to a real date check — `2026-13-45` was accepted before and is refused now.
