# Inbound mail

Gives a scope an **email address** that people forward mail to — a supplier's invoice, a
signed form, a support question — and lands each message in the app through an operation the
app declares, with its attachments stored as files. It is opt-in per address: nothing receives
mail until a scope asks for an address, and an address only ever delivers into the one scope it
was made for.

## At a glance

| | |
|---|---|
| **Provider** | the platform itself — Cloudflare Email Routing on `in.substrat.run` |
| **Category** | Mail, inbound |
| **Status** | **Built**; receiving on `in.substrat.run` starts once Email Routing is switched on for that subdomain, with one rule for `mail@in.substrat.run` and subaddressing on |
| **Package** | `@substrat-run/connector-mail-in` (runs on the platform; you install nothing) |
| **Address** | `mail+<app>-<random>@in.substrat.run`, one per scope, rotatable and revocable |
| **Lands** | through your declared operation, as the address's own connection |

## Declaring where mail lands

Mail lands through **one operation your app names**, holding **one key**. Declare it in the
module's manifest beside any other connection landing:

```ts
connections: [{ provider: 'mail-in', operation: 'docs/receive-mail', permission: 'docs:receive-mail' }]
```

The key appears in your `PERMISSIONS.md` like any other, so who may write mail into your app is
part of the permission diff a reviewer reads. When a scope gets an address, that address — and
nothing else — is granted the key, on that scope only.

The operation is invoked with a `mailInChange` (from `@substrat-run/contracts`), one change per
call:

- **`message`** — the message arrived: who it is from, the subject, the date, the threading
  headers, the text body (cut at 64 KiB, and it says so), how the sender authenticated, and a
  list of its attachments. Answer `{ entity }` — an attachment target in your model — and each
  attachment's bytes are stored on that entity.
- **`attachment`** — one file's bytes are stored, as `attachment`, on the entity you named.

```ts
const receiveMail: OperationHandler = async (ctx, raw) => {
  assertAllowed(await ctx.check(PERM.receiveMail));
  const change = mailInChange.parse(raw);
  if (change.change === 'message') {
    const id = upsertDocumentFor(ctx, change.messageId, change.subject);   // keyed by messageId
    return { entity: { entityType: 'document', entityId: id } };
  }
  recordFile(ctx, change.messageId, change.attachment);
  return {};
};
```

Delivery is **at least once**: key what you write on `messageId` (and the attachment's `index`),
and the same change arriving twice does nothing new. The entity you answer with must be an
attachment target your declared key can write, because the files are stored as the address, not
as a person.

Who did it, on the event log, is the address's connection — never the person who asked for the
address.

## Getting an address

From the app's own worker — the act checked by your own operation first, as with
[`requestConnectUrl`](/reference/vertical-host#requestconnecturl-request):

```ts
import { mailInAddress } from '@substrat-run/vertical-host';

const { principal } = await scope.invoke('docs/manage-mail-in', {});   // your ctx.check
const address = await mailInAddress({
  controlPlaneUrl: env.CONTROL_PLANE_URL,
  platformSecret: env.PLATFORM_SECRET,
  tenantId, scopeId,
  action: 'request',          // or 'get', 'rotate', 'revoke'
  createdBy: principal,
  allowlist: ['me@example.com', '@supplier.example'],
});
```

`request` gives the scope an address, or answers the one it has. `rotate` replaces it — the old
address is refused from then on, and mail it had accepted but not yet delivered moves to the new
one. `revoke` gives it up. The answer carries counts (received, delivered, refused, waiting) for
a settings screen to show; it never names who the mail came from.

The call must come from the app's worker, not from inside a Durable Object: an address delivers
into the scope it names, so the platform only mints one for a caller it can prove is that scope.

## Who may send

Cloudflare already refuses mail that fails the sending domain's DMARC policy, and mail that
passes neither SPF nor DKIM. With no allowlist, that is the whole check: anyone who knows the
address can send to it, which suits an address you hand out to suppliers.

An **allowlist** narrows it to named senders — whole addresses, or `@domain` for anyone there.
Then a name in the `From:` line is not enough, since anyone can write one: the sender must be
**proven**, by DMARC (or an aligned DKIM signature) for the `From:` address, or by SPF for the
envelope sender. For the "forward my own invoices" case, put your own addresses on the list, and
a leaked address becomes close to useless.

Everything refused is refused while the sending server waits, so the sender gets a bounce and
nothing is stored: an address that does not exist, one that was revoked, a message over 25 MiB,
and a sender the allowlist does not admit. An unknown and a revoked address get the same answer.

## The flow

1. Email Routing on `in.substrat.run` hands the message to the platform.
2. The address is looked up; anything refused is refused here, at SMTP time.
3. The message is stored and recorded as waiting, keyed on its `Message-ID` (or its bytes when
   it has none). The same message sent again is accepted and not stored twice.
4. Delivery runs straight away: the message is parsed, the `message` change lands, then each
   attachment's bytes and its `attachment` change. Progress is kept after every step.
5. A delivery that fails is retried with backoff by the platform's connector pass (every 15
   minutes), resuming where it stopped. After eight attempts the message is set aside as
   dead-lettered and kept for an operator.
6. Once delivered, the platform deletes its copy: the message lives in your app, as your app
   chose to keep it.

## Limits

| | |
|---|---|
| Message size | 25 MiB, refused at SMTP time above it |
| Attachments landed per message | 20 (the rest are listed on the `message` change, not stored) |
| Text body carried | 64 KiB, `textTruncated: true` above it |
| HTML body | not carried; `hasHtml` says whether there was one |
| Allowlist | 20 entries |

## What's missing

- **The dashboard view of an address** (request, rotate, revoke from Settings) is not there yet;
  today an app asks through `mailInAddress`.
- **Replaying a dead-lettered message** is an operator's act with no button: the message is kept,
  but nothing re-queues it yet.
- **Previews and forks** cannot have an address — they cause no outbound effects, and an address
  would let one receive the tenant's real mail.
