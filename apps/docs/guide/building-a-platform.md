---
description: "Run your own product on Substrat with each of your customers as a tenant: sell parts of it per customer, build on engines and connectors, and where third-party extensions stand."
---

# Building a platform on Substrat

Some products are platforms themselves. You run one app, every business that buys it gets
its own space, and you sell parts of it separately: the accounting sync to one customer, the
webshop sync and ads reporting to another. Later you may want customers to build their own
additions and offer them to each other.

This page describes that pattern: what each layer is, who builds which part, what runs
today, and what is still unbuilt. The example throughout is a **business portal**: a CRM
that keeps contacts in step with an accounting system, a webshop and a mail and calendar
suite, sold to small companies one add-on at a time.

## Four layers

| Layer | What it is | Who writes it | Status |
|---|---|---|---|
| **[Engines](/engines/)** | Domain logic with guarantees: invoices that cannot change after export, states that cannot be skipped, every change recorded | Substrat | **shipped** |
| **[Connectors](/connectors/)** | Access to an outside system: the stored credential, the calls, the polling | Substrat, or your app ([your own connector](/connectors/your-own)) | platform connectors **shipped**; your own **proposed** |
| **Your vertical** | The product your customers use: the portal's contacts, companies, inbox, screens and roles | You | **shipped** |
| **Extensions** | Separately installed additions to your vertical, written by you or by your customers | You, then your customers | **planned, unbuilt** (see [below](#extensions-planned)) |

Any vertical can compose any engine and use any connector. The portal's "quotes" feature
can be [invoicing](/engines/invoicing/) plus the [Scrive](/connectors/scrive) connector for
signing, and its AI helper can be the [assistant](/engines/assistant/) engine. Neither is
written twice.

## Who builds what

One test decides it: **would a completely different product need this unchanged?** Picture
a field-service company reselling its own app. If that product would need the piece as it
is, the piece belongs in Substrat. If it mentions contacts, deals, campaigns or your prices,
it belongs in your product.

| Concern | Substrat | Your product |
|---|---|---|
| Customers | Tenants, isolation, a [manager](#your-company-is-the-manager) creating tenants | Sign-up, onboarding, which plan a new customer starts on |
| The app | Hosting, operations, permissions, events | The vertical: its entities, screens and roles |
| Integrations | Generic connectors (an accounting system, a webshop, an ads platform) | How their data maps onto your entities: which accounting customer is which contact |
| Selling | Entitlements: whether a tenant holds a key, with plan, quota and expiry | Prices, payment, invoices to your customers |

Substrat records usage ([metering](/engines/metering/)) but bills nobody. You take the
payment, then set the entitlement that matches it.

A piece moves down a layer once it turns out to be generic. When your webshop integration
contains nothing about your CRM, it is a connector, and it belongs in the platform where
every vertical can use it.

## Running it today

### Your company is the manager

Your own admin app is a vertical in your own tenant. It creates one tenant per customer
through the `provision-tenant` platform intent, and each created tenant records yours as
`provisionedByTenant` ([tenants and scopes](/concepts/tenancy)). Provisioning is a granted
capability: your app declares `substrat.provisions`, and staff turn it on for that vertical
([the deploy model](/concepts/deploying)). A push cannot grant it to itself.

### Each customer gets your vertical in their own tenant

Every customer's data lives in their own tenant, and so do their connections. When a
customer connects their accounting system, the credential belongs to their tenant and to
your vertical, and no other customer's install can reach it.

### Selling parts of your app

An entitlement is a key a tenant holds, with an optional `plan`, `quota` and `expiresAt`
([the platform layer](/concepts/platform)). There are two ways to use one:

- **A whole engine.** An engine your vertical composes is gated by its own key. A tenant
  without `invoicing` gets `not_found` from every invoicing operation, without a redeploy.
- **A part of your vertical.** Your manager app declares the keys it sells, such as
  `accounting-sync` or `ads`, and grants them per customer with `set-entitlements`. The
  vertical reads them with `ctx.entitlement(key)` and decides what each key turns on: an
  operation, a screen, a sync.

The second is written by hand today. The kernel enforces a key's presence and its expiry at
the operation boundary for whole modules only. Inside your vertical you write each check,
and nothing stops a customer connecting a system for an add-on they have not bought; the
operations that use the connection have to refuse instead. A module's own declared
schedules keep running after its key lapses, by design, so make a sync schedule check the
key too.

Two limits apply to declaring keys. A plain vertical may declare only its own slug and the
engine keys, which is why the manager declares the add-on keys. And `set-entitlements`
updates one scope of the tenant at a time today.

### Splitting into several verticals

You can ship an add-on as a separate vertical installed into the same tenant and connect it
to your main app with [peer calls and exported events](/concepts/cross-vertical). For a
CRM-shaped product this costs more than it saves:

- Only events classified `piiClass: 'none'` cross between verticals, and contact data is
  personal data.
- A connection belongs to one vertical, so two verticals that both need the accounting
  system ask the customer to connect it twice.
- Each vertical is deployed and pinned separately, and cross-vertical events are still
  **building**.

For add-ons you write yourself, keep them inside your vertical and gate them with keys.

## Extensions (planned) {#extensions-planned}

::: warning Planned, unbuilt
Nothing in this section exists yet. It describes the direction, so that a product being
designed now does not paint itself into a corner. Substrat has **no third-party
marketplace** today ([what Substrat doesn't have](/guide/what-substrat-lacks)).
:::

Letting customers write additions, sell them to each other, or remix someone else's means
running one customer's code against another customer's data. Gating keys inside your
vertical can't do that, because all of that code would ship in your one codebase. An
extension has to be its own deployed unit:

- **Your vertical declares an extension surface.** It lists the operations extensions may
  call, the events they may read and the screen slots they may fill, such as a tab on a
  contact. Everything else stays private, as another module's tables are today.
- **An extension declares what it extends and what it needs:** "read contacts", "create
  invoices", "call the webshop's API". It runs in its own worker and keeps its own data in
  the customer's tenant, and it can compose engines and use connectors like any vertical.
- **Installing is consent.** The customer's admin sees the capability list and approves it.
  An upgrade that asks for more is approved again, and an install stays on the version it
  was installed at until the customer moves it.
- **Third-party screens run sandboxed,** in an isolated frame that never sees the customer's
  session and can reach only the hosts that were approved.
- **Connections are shared.** An extension uses the customer's existing connection through
  an approved capability instead of asking them to connect again.
- **The catalog belongs to you.** Your customers see a catalog of extensions for your
  product, and you decide what is listed in it. Substrat holds the records, the review
  state and a kill switch across every tenant. You build the storefront and set the
  policy.
- **Remix keeps its source.** Publishing stores the extension's source and the author's
  licence choice, so a remix is a copy with a recorded origin. Whether a paid remix owes
  the original author anything is your policy, not a platform rule.

Selling between customers stays in your product. An entitlement can say that tenant B holds
extension X; taking B's money and paying the author is your code.

Build your own add-ons as extensions as soon as the surface exists. Then the extension
surface has real users before any customer depends on it, and a customer's remix of one of
your add-ons is an ordinary extension.

## What is shipped and what is not

| Piece | Status |
|---|---|
| A manager vertical creating customer tenants and setting their entitlements | **shipped** |
| Entitlement keys with plan, quota and expiry, read at request time | **shipped**; quota and plan are yours to enforce |
| Engines composed inside your vertical | **shipped** |
| Platform connectors, one connection per tenant and vertical | **shipped** |
| Your own connector, shipped with your vertical | **proposed** (D-64) |
| Peer calls and exported events between verticals in one tenant | **building** |
| Declared add-on gates (operations, screens, schedules and connections by key) | planned, unbuilt |
| Extensions: extension surface, consent, sandboxed screens, shared connections | planned, unbuilt |
| A catalog owned by a manager, review, kill switch, remix | planned, unbuilt |
| Billing your customers | not planned in the platform; yours |
