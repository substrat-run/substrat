---
'@substrat-run/contracts': minor
'@substrat-run/control-plane': patch
'@substrat-run/dashboard': patch
---

A Microsoft 365 connection can now sign in with your own certificate: give the private key and the certificate your Entra admin already uploaded, and the platform checks they are one RSA pair, seals the key with the connection, and shows the certificate's thumbprint and end, marked as yours. The platform never renews a certificate you supplied; the connection warns from 30 days before its end, and you can replace it with a new pair or switch to a generated certificate without stopping mail. `ConnectionCertificate` gains an optional `supplied` flag for it.
