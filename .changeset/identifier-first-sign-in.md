---
'@substrat-run/demo-auth-server': minor
---

Identifier-first sign-in, per application. An application can ask for an email (or BankID) first and pick the method from the address: addresses at a configured domain are sent to one provider and can sign in no other way, everyone else gets the password form — with the SMS code after it when the application requires one. The rule is enforced at the authorize endpoint, so a password registered under a routed address does not get a code. The application editor now lays the settings out as start screen, methods open to everyone, domain rules and a preview of what people will see.
