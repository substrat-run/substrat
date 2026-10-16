/**
 * The three read paths, drawn as the comparison the page is actually making.
 *
 * A table gives latency and consistency per path but not the thing that decides
 * between them: how far the data has travelled from the scope that owns it.
 * That distance IS the staleness, and it is why the default has none — the
 * a successful projection consumer runs in the same serialized turn as the write
 * it derives from, in a separate transaction. A failed consumer can leave it behind.
 *
 * Drawn as increasing distance from one boundary rather than three peer boxes:
 * three boxes side by side would restate the table, which is the failure mode
 * the picture exists to avoid.
 *
 * Same contract as the sibling content modules: a fact typed into the template
 * renders on the page and vanishes from llms.txt. Put it here.
 */

export const aria =
  'Three read paths at increasing distance from the scope. An in-scope read is a local ' +
  'indexed query. An external read model is fed by events and is eventually ' +
  'consistent. The history tier is fed by export and is not a read tier for interactive use.';

export interface Path {
  readonly n: number;
  readonly title: string;
  readonly latency: string;
  readonly consistency: string;
  readonly use: string;
  readonly how: string;
  readonly inside: boolean;
}

export const paths: readonly Path[] = [
  {
    n: 1,
    title: 'In-scope read',
    latency: 'µs',
    consistency: 'serializable',
    use: 'everything interactive',
    how: 'local tables; projection consumers run after commit in the same turn',
    inside: true,
  },
  {
    n: 2,
    title: 'External read model',
    latency: 'ms',
    consistency: 'eventually consistent',
    use: 'a scope whose reads outgrow its executor',
    how: 'fed by events off the spine',
    inside: false,
  },
  {
    n: 3,
    title: 'History tier',
    latency: 'seconds',
    consistency: 'eventually consistent',
    use: 'reporting, audit, cross-scope',
    how: 'exported to Iceberg / R2 SQL',
    inside: false,
  },
];

export const boundary =
  'the scope boundary — everything below it is allowed to be behind';

export const order = 'Reach for them in this order.';

export const caption =
  'An in-scope projection has no visible gap when its consumer succeeds; a failed consumer can leave it behind. ' +
  'External projections have delivery lag. The history gateway is staff-only and requires configuration; ' +
  'it is not an interactive read tier.';

export function alt(): string {
  return [
    `**Diagram — the three read paths.** ${order} The further a path sits from the scope that ` +
      'owns the data, the staler it is allowed to be.',
    '',
    ...paths.map(
      (p) =>
        `${p.n}. **${p.title}** — ${p.latency}, ${p.consistency}. For ${p.use}. ` +
        `${p.inside ? 'Inside the scope boundary' : 'Outside the scope boundary'}: ${p.how}.`,
    ),
    '',
    caption,
  ].join('\n');
}
