# @substrat-run/connector-microsoft365

A tenant's own Microsoft 365, over Microsoft Graph with app-only client credentials in the
tenant's Entra directory. Today it sends mail as the tenant's own addresses: it implements the
kernel's `MailSender`, so the platform's email relay routes a message to it when the message's
`from` is one of the connection's addresses.

Signs in with a per-connection certificate the platform generates (the private key never leaves
the platform; the tenant uploads the certificate), or with a client secret. Host code, never
module code.

Setup and limits: [substrat.net/connectors/microsoft365](https://substrat.net/connectors/microsoft365).
