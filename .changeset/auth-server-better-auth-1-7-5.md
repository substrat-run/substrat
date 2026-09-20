---
'@substrat-run/demo-auth-server': patch
---

The auth server moves to Better Auth 1.7.5, and an issuer that already ran 1.7.0–1.7.2 upgrades itself on the next boot.

Better Auth 1.7.0–1.7.2 added a required `issuer` column to `account` and keyed an account by `(issuer, accountId)`. 1.7.3 took both back: an account is again `(providerId, accountId)`, as it was in 1.6, and nothing writes `issuer` any more. On a store that had the column, every new sign-up and account link — the password ones too — failed with `NOT NULL constraint failed: account.issuer`, leaving a user with no account behind. The boot-time upgrade now drops the column and its index, and keeps every account, credential and link. A store from 1.6 never had the column and is left alone. One case is refused rather than dropped: if two rows share `(provider_id, account_id)` and differ only by issuer, the boot stops with an error naming the providers and leaves `account` untouched, because the issuer is the only thing that tells those rows apart. Resolve them (or roll the deploy back) and boot again.

Two visible changes. `GET /api/admin/users/:userId/sign-in-methods` no longer returns `issuer` on each method (nothing in the console read it; `provider` and `accountId` are the key now). And a custom OIDC upstream's account is namespaced by its provider id rather than by the upstream's own issuer, so removing and re-adding an upstream keeps its people only under the same id.
