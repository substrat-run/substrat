---
'@substrat-run/contracts': minor
'@substrat-run/control-plane': patch
'@substrat-run/dashboard': patch
---

Connecting Microsoft 365 now asks how it signs in, as one explicit choice: a client secret (the quickest, and the default), a platform-generated certificate (the most secure: its private key never leaves the platform), or your own certificate. An empty client secret no longer quietly means "generate a certificate", and rotating starts on the method the connection uses, keeping a secret or key left empty. A client secret takes an optional end date, the one Entra shows, and the connection warns from 30 days before it. Your own certificate is its private key and the `.cer` your Entra admin already uploaded: checked to be one RSA pair, sealed with the connection, shown by thumbprint and end, never renewed by the platform, and warned about from 30 days before it ends; replace it with a new pair or switch to a generated certificate without stopping mail. `ConnectionCertificate` gains an optional `supplied` flag.
