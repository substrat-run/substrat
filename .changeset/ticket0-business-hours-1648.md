---
'@substrat-run/demo-ticket0': minor
---

Ticket0 desks can set structured opening hours, and service levels can count only those hours (#1648).

- New `businessHours` desk setting: weekly windows per weekday in an IANA timezone, plus dated exceptions that replace a day (`[]` is a holiday, windows are special hours). Times are local wall-clock times. Across a DST change, a time that doesn't exist moves forward and a repeated one takes the earlier instant. What counts is real elapsed time inside the windows.
- `sla.clock: 'business'` opts a desk's targets into business time. A Friday-evening mail with a four-hour target falls due on Monday. Absent, the clock is calendar time as before. A business clock with no usable hours also counts calendar time, so a target can always run out.
- A snooze on the business clock gives back the business time it covered, not the whole wall-clock span. A priority change re-aims in business time too.
- The breaching-soon window counts on the same clock: at 16:50 on a Friday, a 60-minute window includes a target due at 09:10 on Monday.
- The widget's opening-hours line is derived from the structured hours (`Mon–Fri 09:00–17:00 (Europe/Stockholm)`). The existing free-text `businessHours` is kept, unparsed, as the fallback note shown when no structured hours are set.
- Settings gets an opening-hours editor and a "Count only opening hours" switch under Service levels.
