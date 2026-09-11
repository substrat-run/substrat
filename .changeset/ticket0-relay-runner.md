---
---

ticket0's email relay now has a process behind it: a sweep that finds public replies on
email conversations with no delivery recorded, reads each one back, hands it to a mail
provider and records what the provider named it. Demo-only — `demos/ticket0` is private
and no published package changed.
