---
'@substrat-run/contracts': patch
'@substrat-run/kernel': patch
---

A derived list narrowed to a parent pages only that parent's rows. `defineOperations` refuses a second input field over the parent's link column (`deal_id` beside the checked `dealId`), which let a caller pass the check on one parent and page another's rows, and the derived handler pins the link column to the checked id even for a plan built before that refusal.
