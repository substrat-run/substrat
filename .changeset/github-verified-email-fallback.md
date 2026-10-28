---
"@substrat-run/demo-auth-server": minor
"@substrat-run/demo-auth-server-app": minor
"@substrat-run/dashboard": minor
"@substrat-run/dashboard-web": minor
"@substrat-run/boundary-lint": patch
---

Add verified-email fallback for GitHub sign-in when GitHub provides no verified email or the address differs from the dashboard invitation. Send a browser-bound, single-use verification link that expires after ten minutes, then resume the original OIDC request with the verified account email and the same GitHub identity.

Preserve existing user IDs and require an existing account's fresh session before explicitly connecting an email-less GitHub identity. Refuse automatic account merges, expired or replayed proofs, and addresses belonging to another account. Keep provider restrictions, sign-up policy and invitation checks in place.

Offer the fallback from dashboard invitation mismatches and distinguish pending email verification in the sign-in log. Recognize the GitHub email plugin as auth adapter code in the boundary linter.
