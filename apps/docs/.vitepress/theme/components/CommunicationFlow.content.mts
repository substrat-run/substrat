/** Shared facts for the book's SVG figures and their plain-text editions. */
interface Step {
  owner: string;
  title: string;
  lines: string[];
  layer: 'vertical' | 'kernel' | 'engine';
}
interface Flow {
  title: string;
  aria: string;
  steps: Step[];
  edges: string[];
  caption: string;
}

export const flows: Record<string, Flow> = {
  peer: {
    title: 'One peer call · one tenant',
    aria: 'The board-room host declares it calls the CRM. The platform proves the calling app and resolves the target in the same tenant. The CRM admits the peer, checks its permissions and runs its own transaction. The result returns to the calling host.',
    steps: [
      { owner: 'CALLER · BOARD-ROOM HOST', title: 'Ask for current customer details', layer: 'vertical',
        lines: ['Declares: calls acme/crm', 'Invokes: customer/get'] },
      { owner: 'PLATFORM · IDENTITY AND ROUTING', title: 'Prove who calls; find the target', layer: 'kernel',
        lines: ['Caller identity comes from the dispatch.', 'Target is in the same tenant.'] },
      { owner: 'TARGET · CRM SCOPE', title: 'Admit, check, then run', layer: 'vertical',
        lines: ['CRM declares the peer and its operations.', 'Its checks and transaction run here.'] },
    ],
    edges: ['platform-asserted app identity', 'request enters through the peer door'],
    caption: 'The result returns to the host. Each scope keeps its own transaction. Module code queues a platform intent instead of making this synchronous call.',
  },
  events: {
    title: 'One exported fact · two commits',
    aria: 'The CRM commits its row and event together. The platform reads allowed exports after the board-room’s saved watermark. The board-room commits each handler’s writes with its delivery record, then advances its watermark. A paused edge holds the watermark.',
    steps: [
      { owner: 'PRODUCER · CRM DATABASE', title: 'Commit the fact', layer: 'vertical',
        lines: ['Customer row + event commit together.', 'The event stays in the CRM outbox.'] },
      { owner: 'PLATFORM · PULL AND DELIVER', title: 'Read after the saved watermark', layer: 'kernel',
        lines: ['Export ∩ import, with checks on both sides.', 'Only the agreed version and PII class none.'] },
      { owner: 'CONSUMER · BOARD-ROOM DATABASE', title: 'Apply, record, then advance', layer: 'vertical',
        lines: ['Handler writes + delivery row commit together.', 'Watermark advances after the batch.'] },
    ],
    edges: ['kick for speed · sweep as backstop', 'separate transaction in the receiver'],
    caption: 'The consumer owns the bookmark. Pause holds it. Restore rewinds it with the data. Ordinary redelivery skips recorded deliveries; explicit replay runs handlers again.',
  },
  notifications: {
    title: 'One notification · three responsibilities',
    aria: 'The vertical names the occasion and recipients. The notifications engine applies preferences and records the delivery with an email intent in the same transaction. After commit the platform sends mail and emits an outcome that settles the delivery.',
    steps: [
      { owner: 'VERTICAL · BUSINESS MEANING', title: 'A repair was assigned', layer: 'vertical',
        lines: ['Choose topic, recipients and wording.', 'Use the event id as the occasion’s key.'] },
      { owner: 'ENGINE · IN THE SAME TRANSACTION', title: 'Decide and record the notification', layer: 'engine',
        lines: ['Apply preferences; render the template.', 'Delivery row + email intent commit together.'] },
      { owner: 'PLATFORM · AFTER COMMIT', title: 'Send, then report the outcome', layer: 'kernel',
        lines: ['Send through the configured mail provider.', 'Sent, refused or dead-lettered settles the row.'] },
    ],
    edges: ['notify(ctx, …)', 'commit ends the scope transaction'],
    caption: 'A rollback leaves no send. A committed intent survives a crash. The delivery row is deduplicated, but a provider send can repeat if its outcome was lost.',
  },
  assistant: {
    title: 'One assistant turn · an approved change',
    aria: 'A person starts a turn. The host acquires a run lease, calls a model outside the transaction and records events. A proposed change waits for the person’s approval of exact input. The host must claim that approved call before executing and recording its result.',
    steps: [
      { owner: 'PERSON · ASSISTANT:USE', title: 'Start a turn', layer: 'vertical',
        lines: ['Append the person’s message.', 'The engine opens a turn on their thread.'] },
      { owner: 'HOST · ASSISTANT:RUN', title: 'Take the lease and run the model', layer: 'engine',
        lines: ['One run may write at a time.', 'Model calls happen outside transactions.'] },
      { owner: 'PERSON · EXACT APPROVAL', title: 'Review the proposed change', layer: 'vertical',
        lines: ['Digest binds input, operation and version.', 'Deny or let it expire: no execution claim.'] },
      { owner: 'HOST · CHECK BEFORE EXECUTING', title: 'Claim once, execute, record', layer: 'engine',
        lines: ['Changed input or a second claim is refused.', 'The target still checks its own permissions.'] },
    ],
    edges: ['short engine calls record progress', 'a gated tool call pauses for approval', 'only the approved call may be claimed'],
    caption: 'The engine records and gates the turn. The host runs it. The execution claim cannot make an external effect atomic with the conversation record. Host integration is still to come.',
  },
};

export function flowFor(kind: string): Flow {
  const flow = flows[kind];
  if (!flow) throw new Error(`Unknown communication figure: ${kind}`);
  return flow;
}

export function alt(props: Record<string, string>): string {
  const flow = flowFor(props.kind ?? 'peer');
  return [
    `**Diagram — ${flow.title}.**`, '',
    ...flow.steps.flatMap((step, i) => [
      `${i + 1}. **${step.title}** (${step.owner}). ${step.lines.join(' ')}`,
      ...(flow.edges[i] ? [`   Then: ${flow.edges[i]}.`] : []),
    ]),
    '', flow.caption,
  ].join('\n');
}
