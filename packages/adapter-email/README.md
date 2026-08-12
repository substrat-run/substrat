# @substrat-run/adapter-email

The platform's **notification-transport port** — how [Substrat](https://substrat.net) sends
transactional email (invites, password resets, receipts).

**Internal to this monorepo — not published to npm** (see Status). Background on where it sits:
**https://substrat.net/platform**

Email is an **adapter, not a connector** (decision 18): a notification transport is
*infra the host consumes*, not a capability a tenant connects their own account to.
So it lives here in `packages/`, is selected by platform/deployment config, and is
**host code — never module code** (module code has no network access; mail is sent by
the host after commit, driven by the outbox).

## The port

One interface, swappable implementations:

```ts
interface EmailTransport {
  send(message: EmailMessage): Promise<SendResult>;
}
```

| Implementation | Use |
|---|---|
| `CloudflareEmailTransport` | **Default.** Cloudflare Email Service via the `send_email` Workers binding. |
| `MockEmailTransport` | Dev, CI, and scenario tests — records an in-memory outbox, simulates bounces/outages. |

Callers depend on `EmailTransport` only. Which implementation runs is a config choice,
never a code change — that is the whole point of the port ([master-plan.md] "an adapter
with a single implementation is a wrapper").

The port owns the deliverability invariants (`prepareMessage`): every message must carry
**both** an `html` and a `text` part, a non-empty subject, and at least one valid
recipient. A programmer error fails fast against the mock in CI rather than as a silent
spam-folder loss in production.

## Cloudflare Email Service — why it's the default

For *internal platform* mail on `substrat.run` specifically:

- Same platform — **no new sub-processor** (Cloudflare is already the foundational one).
- The zone's DNS is already on Cloudflare, so onboarding auto-configures **SPF/DKIM**.
- Managed IP reputation, soft-bounce retries, and **suppression lists** are handled by
  the service; hard bounces come back in `SendResult.bounced`.
- The `send_email` binding **is** the credential — no API key to store.

The one thing a spec can't promise is **inbox placement at volume**. Because this is a
swappable port, that risk is hedged: a warmer provider (**Resend**) is a third
implementation of the same interface — added the day measured deliverability disappoints,
or the day a *vertical* needs to send business mail from the tenant's own domain (which is
the point where a per-tenant **connector** — not this adapter — enters the picture).

### Wiring (Worker)

```jsonc
// wrangler.jsonc
{ "send_email": [{ "name": "EMAIL" }] }
```

```ts
import { CloudflareEmailTransport } from '@substrat-run/adapter-email';

const mail = new CloudflareEmailTransport(env.EMAIL);
await mail.send({
  to: 'invitee@example.com',
  from: { email: 'no-reply@substrat.run', name: 'Substrat' },
  subject: 'You have been invited to Acme',
  html: '<p>Join Acme: <a href="…/accept/…">accept</a></p>',
  text: 'Join Acme: …/accept/…',
});
```

Onboard the sending domain once: `wrangler email sending enable substrat.run`.

## Status

Skeleton: the port + the Cloudflare and mock implementations, unit-tested. **Not yet
wired** into the invites executor or the dashboard/console workers — that is the next
step (send on `invites.sent`, host-side, after commit). Kept `private` until it has a
second real provider and is exercised end to end against a live domain.
