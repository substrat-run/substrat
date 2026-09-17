/**
 * How work a scope committed gets out of it: one transaction, two ways the platform
 * learns about it, and the control plane as the only thing that ever acts.
 *
 * Two facts the picture exists to carry, because prose loses them. First, the kick and
 * the sweep are not alternatives: the kick is the latency path and the sweep is the
 * reliability path, and a lost kick costs seconds becoming minutes, never correctness.
 * Second, the kick NAMES a scope and carries no data — the control plane reads the rows
 * itself — which is why a flag any vertical can set is safe to act on.
 *
 * It is drawn as built, not as planned. Events have no kick yet: they leave only through
 * the sweep. When the event kick lands, `kick.sub`, `events.sub` and the caption change
 * here and the drawing does not.
 *
 * Same contract as the sibling content modules: a fact typed into the template renders on
 * the page and vanishes from llms.txt. Put it here.
 */

export const aria =
  'One operation commits its rows, its events and any platform intents in a single ' +
  'transaction. Two paths then reach the control plane: a flag on the response, which the ' +
  'router turns into an immediate drain of that scope, and a sweep every 15 minutes over ' +
  'every active scope. The control plane reads the scope itself, executes intents, and ships ' +
  'events to the Tier-2 lake.';

export interface Box {
  readonly tag: string;
  readonly title: string;
  readonly sub: readonly string[];
}

export const commit: Box = {
  tag: 'in the scope · one transaction',
  title: 'An operation commits',
  sub: ['your rows · its events in _substrat_outbox', 'a platform intent, if it asked for one'],
};

/** The latency path. */
export const toKick = 'response flagged';

export const kick: Box = {
  tag: 'latency · seconds',
  title: 'The router kicks',
  sub: ['returns the response to the user first', 'then asks for a drain · intents only, today'],
};

/** The reliability path. Nothing flows INTO it: it runs on a clock, not a signal. */
export const sweep: Box = {
  tag: 'backstop · every 15 minutes',
  title: 'The platform sweep',
  sub: ['walks every active scope', 'catches anything a kick missed'],
};

export const fromKick = 'names a scope, carries no data';
export const fromSweep = 'each active scope';

export const platform: Box = {
  tag: 'platform · the only thing that acts',
  title: 'The control plane drains the scope',
  sub: [
    "reads the rows itself, through the vertical's /internal routes",
    "so a kick can speed up a scope's own work, never forge it",
  ],
};

export const toIntents = 'executes';
export const intents: Box = {
  tag: 'intents',
  title: 'Run with platform authority',
  sub: ['executed outside the scope', 'outcome written back to its intent journal'],
};

export const toEvents = 'ships';
export const events: Box = {
  tag: 'events · tier 2',
  title: 'Shipped to the lake',
  sub: ['marked shipped only once the lake confirms', 'through the sweep only — no kick yet'],
};

export const caption =
  'The kick and the sweep are not alternatives. The kick makes it fast; the sweep makes it ' +
  'certain — a lost kick costs a wait, never a missed intent or event. Neither carries data: ' +
  'the control plane always reads the scope itself.';

export function alt(): string {
  const line = (b: Box) => `**${b.title}** (${b.tag}) — ${b.sub.join('; ')}.`;
  return [
    '**Diagram — how committed work leaves a scope.**',
    '',
    `1. ${line(commit)}`,
    '2. Two paths reach the control plane:',
    `   - ${toKick}: ${line(kick)} It ${fromKick}.`,
    `   - ${line(sweep)} It runs on a timer rather than a signal, and drains ${fromSweep}.`,
    `3. ${line(platform)}`,
    `4. It ${toIntents} intents — ${line(intents)}`,
    `5. It ${toEvents} events — ${line(events)}`,
    '',
    caption,
  ].join('\n');
}
