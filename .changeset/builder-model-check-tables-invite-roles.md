---
'@substrat-run/builder': patch
'@substrat-run/builder-workspace': patch
'@substrat-run/builder-generator': patch
---

check_model also emits the model's tables, so a field no column can hold is caught while the model may still change, and the migrations gate asks a repair for it instead of reporting it blocked. A new invite-roles gate refuses invitations offered at a role no inviting role covers.
