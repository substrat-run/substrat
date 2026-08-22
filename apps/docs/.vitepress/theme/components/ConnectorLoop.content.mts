/**
 * The connector round trip, and its markdown twin.
 *
 * Replaces the ASCII block that stood in connectors/index.md. The ASCII said
 * the same things; what it could not show is why the loop leaves the scope at
 * all — the scope has no fetch and nowhere to keep a credential, so the delivery
 * is handed OUT to the worker and the result comes back in through a different
 * door, on the connection's own authority.
 *
 * Same contract as the sibling content modules: a fact typed into the template
 * renders on the page and vanishes from llms.txt. Put it here.
 */

export const aria =
  'The Scope Durable Object delegates an outbox delivery up to the connector runtime in ' +
  'the vertical worker, which opens the sealed credential and calls the provider with a ' +
  'bound fetch. The provider’s callback returns to the worker, which reopens the scope ' +
  'through getConnectorScope with the connection as its subject.';

export const scope = {
  tag: 'durable object',
  title: 'Scope DO',
  sub: ['The operation committed;', 'the event is in the outbox.'],
  chip: 'no fetch() here — the lint forbids it',
} as const;

export const runtime = {
  tag: 'worker',
  title: 'Connector runtime',
  sub: ['Opens the sealed credential', 'for this tenant.'],
  chip: 'fetch bound to the connection · retry',
} as const;

export const provider = {
  tag: 'outside the platform',
  title: 'The provider',
  sub: 'Scrive, Fortnox, a bank.',
  chip: 'never sees a principal',
} as const;

export const arrows = {
  out: 'delegates the delivery',
  back: 'getConnectorScope()',
  send: 'sends the document',
  callback: 'the provider calls back',
} as const;

export const caption =
  'A provider’s callback is not a person, so it cannot hold a principal. The connection ' +
  'itself is the subject: getConnectorScope opens a stub whose authority is that ' +
  'connection’s own grants, narrowed by construction to one tenant and one vertical.';

export function alt(): string {
  return [
    '**Diagram — the connector round trip.** A delivery leaves the scope, crosses the ' +
      'platform boundary, and comes back in through a different door.',
    '',
    `1. **${scope.title}** (${scope.tag}) — ${scope.sub.join(' ')} ${scope.chip}.`,
    `2. It **${arrows.out}** up to the **${runtime.title}** (${runtime.tag}) — ` +
      `${runtime.sub.join(' ')} ${runtime.chip}.`,
    `3. The runtime **${arrows.send}** to **${provider.title}** (${provider.tag}) — ` +
      `${provider.sub} It ${provider.chip}.`,
    `4. Later, **${arrows.callback}**; the worker reopens the scope with ` +
      `\`${arrows.back}\` and writes the result back.`,
    '',
    caption,
  ].join('\n');
}
