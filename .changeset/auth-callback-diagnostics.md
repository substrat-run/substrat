---
"@substrat-run/demo-auth-server": patch
---

Add safe callback diagnostics to the admin sign-in log so failed federated sign-ins identify the token-exchange or profile-lookup stage. When GitHub returns no email, record a bounded follow-up email check with HTTP status, first-page address counts and permission guidance. Keep tokens, email addresses, profiles and raw exception messages out of these summaries.
