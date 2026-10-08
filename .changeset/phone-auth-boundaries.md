---
"@substrat-run/boundary-lint": patch
"@substrat-run/demo-auth-server": minor
---

Add email account invitations with BankID linking or password and Twilio Verify SMS enrollment. Applications can require BankID or password plus SMS, enforced when issuing an authorization code. Configure the Twilio account SID, auth token, and Verify service SID to enable SMS.

Recognize the invitation and phone-factor plugins and Twilio transport as server auth wiring in the boundary linter.
