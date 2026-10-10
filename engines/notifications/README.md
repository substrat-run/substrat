# @substrat-run/engine-notifications

Notifications engine for [Substrat](https://github.com/substrat-run/substrat). It turns an
occasion a vertical names into email to the people it concerns, with per-person
preferences, escaped templates and tracked deliveries.

**Not published yet** (`private: true`). The Handlebar demo uses it in-repo until its first
release is set up.

## How a vertical uses it

The engine is composed **by call**. Register the module, then call `notify` inside your own
transaction wherever something is worth telling someone, usually your own consumer of a
domain event:

```ts
import { notificationsModule, notify } from '@substrat-run/engine-notifications';

host.registerModule(notificationsModule);

// In your module's `consumers`:
'workorder.assigned': async (ctx, event) => {
  const { orderId, technician } = assignedPayload.parse(event.payload); // your own parse
  notify(ctx, {
    topic: 'repair-assigned',
    description: 'A repair was assigned to you', // shown beside the switch
    dedupeKey: event.id, // a redelivered event mails nobody twice
    recipients: [technician], // principal ids, never addresses
    vars: { orderId },
    about: event.entity,
    template: { subject: 'New repair: {{orderId}}', text: 'You have repair {{orderId}}.' },
  });
},
```

`notify` checks no permission, like every by-call engine function: the caller checks first.

**Prerequisite: the vertical's `emailSender` grant.** `notify` writes its sends with the kernel's `requestEmail`, and the platform delivers those only for a vertical that staff have granted the email-sender capability (the console's `setVerticalEmailSender`). Without it, nothing fails at the call: every delivery is written `requested`, and then settles `refused` with reason `permission_denied` when the platform's outcome comes back.

## What it owns

- **Dispatch.** For each person, it writes one send intent with the kernel's `requestEmail`
  in the caller's transaction. The platform's drain delivers it through `adapter-email`.
  Nothing here talks to a provider.
- **Templates, rendered safely.** `{{name}}` placeholders are filled from `vars`. A value is
  HTML-escaped in the HTML part and kept to one line in the subject. A placeholder with no
  variable makes `notify` throw `validation_failed`, which rolls back the caller: from a
  consumer, the event dead-letters with the reason; from an operation, the operation fails.
  A blank mail is never sent.
- **Preferences.** Each person sets where their notifications go
  (`notifications/set-my-address`) and switches topics off (`notifications/set-my-preference`).
  A topic passed as `required` cannot be switched off. A topic is recorded the first time it
  is used, and that record is what a preferences screen lists.
- **Delivery tracking.** There is one row per (dedupe key, topic, person, channel), unique on
  those four. It moves from `requested` to `sent`, `refused` or `dead_lettered` when the
  platform's outcome event arrives. A delivery that was not sent says why: `muted` or
  `no_address`.

**One topic, one declaration.** A topic's `description` and `required` are recorded from the call that uses it, and follow the latest caller, so a deploy that changes them updates the scope. Every call site for a topic must pass the same pair: two that disagree make the topic flip with whichever ran last, and a mute be refused or allowed accordingly. Keep each topic in one constant that its call sites spread, and change it there.

## Personal data

Events carry principals, never addresses. The address lives on the engine's recipient row,
which a subject erasure deletes (K-46). The send intent carries the recipient as its
`subjectId`, so the same erasure cancels a send that is still waiting.

## Not yet

Digests, channels other than email (SMS, push, in-app), tenant-edited or per-locale
templates, quiet hours, and a person's own delivery history. See K-47 for where this engine
sits and why it is not kernel code.

## Permissions

| Key | What it allows |
| --- | --- |
| `notifications:self` | Set where your own notifications go and which topics reach you |
| `notifications:read` | Read what became of every notification in the scope |

## Licence

AGPL-3.0-only, or a commercial licence.
