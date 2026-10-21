# Composing & extending


```ts
import { notificationsModule, notify } from '@substrat-run/engine-notifications';

host.registerModule(notificationsModule);

// Your own consumer of a domain event:
const consumers = {
  'workorder.assigned': async (ctx, event) => {
    const { orderId, technician } = assignedPayload.parse(event.payload);
    notify(ctx, {
      topic: 'repair-assigned',
      description: 'A repair was assigned to you',
      dedupeKey: event.id,
      recipients: [technician],
      vars: { orderId },
      about: event.entity,
      template: { subject: 'New repair: {{orderId}}', text: 'You have repair {{orderId}}.' },
    });
  },
};
```

The template is your vocabulary, so it stays in your code. `dedupeKey` names the occasion: from a
consumer, pass the event's id. The engine registers as one frozen constant, like every engine.

**Prerequisite: the vertical's `emailSender` grant.** `notify` writes its sends with the kernel's `requestEmail`, and the platform delivers those only for a vertical whose owning team has enabled **Send email** in the dashboard under **Settings → Permissions** (staff can also override it in the console). Without it, nothing fails at the call: every delivery is written `requested`, and then settles `refused` with reason `permission_denied` when the platform's outcome comes back.

**One topic, one declaration.** A topic's `description` and `required` are recorded from the call that uses it, and follow the latest caller, so a deploy that changes them updates the scope. Every call site for a topic must pass the same pair: two that disagree make the topic flip with whichever ran last, and a mute be refused or allowed accordingly. Keep each topic in one constant that its call sites spread, and change it there.

