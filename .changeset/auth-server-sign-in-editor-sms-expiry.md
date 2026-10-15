---
'@substrat-run/demo-auth-server': patch
---

The application's sign-in settings show their methods at once. The "Accept every method this issuer offers" switch used to hide everything else, including "Require an SMS code after the password", so an operator could not find the option. Every method is now listed, all ticked for an application with no policy; the first change turns that into an explicit list, and "Back to every method" returns to the default, with the SMS step, "Ask for email first" and any domain rules cleared, so the form never shows a setting that saving would not store.

A login page now stays valid for 30 minutes instead of 10 (`codeExpiresIn`, which is also the authorization code's lifetime). The SMS step refuses an expired sign-in before an SMS is sent, and the screen says so with a "Start again" button instead of showing `invalid_signature` after the code has been typed. The time left is measured from when the page loaded rather than read off the device clock, so a phone or laptop whose clock is wrong is not locked out of the step.
