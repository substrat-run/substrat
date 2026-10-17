---
'@substrat-run/contracts': minor
'@substrat-run/connector-microsoft365': patch
'@substrat-run/docs': patch
---

A Microsoft 365 connection's certificate can be rotated before it lapses, without mail stopping (#2100).

`@substrat-run/connector-microsoft365`: a save within 30 days of the current certificate's end, or one that sends `rotateCertificate: 'yes'`, generates a second keypair beside the current one. The current certificate keeps signing, and the connection's expiry stays its end. A later save signs in with the new certificate, and once Entra accepts it, it becomes the current one and the old key is dropped. If Entra refuses it, or cannot be reached, both stay as they were. Once the current certificate has lapsed, the new one takes its place at the next save. Sending signs with the new certificate when the current one has lapsed, or when Entra says the current one is no longer on the app registration. The probe reports whether Entra accepts the new certificate yet, and that check is not recorded as the connection's health. The credential summary shows both thumbprints and both ends. A caller can never supply either key. `prepareMicrosoft365(options)` builds the `prepareCandidate` hook with its sign-in.

`@substrat-run/contracts`: `connectionCertificate` gains an optional `next` (`pem`, `thumbprint`, `notAfter`), the certificate being rotated in. The top-level fields still describe the certificate in use, so a consumer that ignores `next` shows the same thing as before.
