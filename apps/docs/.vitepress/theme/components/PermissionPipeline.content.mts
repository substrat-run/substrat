/**
 * How a permission travels from a TypeScript declaration to a runtime check.
 *
 * Replaces a six-node mermaid `flowchart TD` whose every node was a three-line
 * paragraph of `<b>` and `<br/>`. Dagre sizes a box from its label, so a
 * straight pipeline with one fork rendered as blocks of wildly different widths
 * and the sequence stopped reading as a sequence.
 *
 * The fork matters and is drawn as one: `lint:permissions` is a **review**
 * branch that ends in a human, not a stage the surface passes through on its way
 * to runtime. The old chart drew it as a peer of `push`, which reads as though a
 * permission goes one way or the other.
 *
 * Same contract as the sibling content modules: a fact typed into the template
 * renders on the page and vanishes from llms.txt. Put it here.
 */

export const aria =
  'Permissions are declared in TypeScript. From there one branch renders PERMISSIONS.md for ' +
  'human review and CI drift-checking; the other rides the deploy manifest through admission, ' +
  'provisioning, and finally ctx.check at runtime.';

export interface Stage {
  readonly tag: string;
  readonly title: string;
  readonly sub: readonly string[];
}

export const source: Stage = {
  tag: 'authored',
  title: 'Declared in TypeScript',
  sub: ['module manifests → keys + descriptions', 'roles → templates · entity grants → shapes'],
};

export const toReview = 'renders';

export const review: Stage = {
  tag: 'checkpoint · a human reads this',
  title: 'pnpm lint:permissions',
  sub: ['emits PERMISSIONS.md, the review artifact', 'CI --check fails the build on drift'],
};

export const stages: readonly (Stage & { readonly edge: string })[] = [
  {
    edge: 'substrat push',
    tag: 'ships',
    title: 'The deploy manifest',
    sub: ['the surface rides along as a registry', 'content-hashed → digests.permission'],
  },
  {
    edge: 'promote',
    tag: 'gate',
    title: 'Admission',
    sub: ['a real diff between two versions', 'a widened surface is visible, not implicit'],
  },
  {
    edge: 'at write time',
    tag: 'per tenant',
    title: 'Provisioning',
    sub: ['role templates projected into each', "tenant's own _substrat_roles"],
  },
  {
    edge: 'every operation',
    tag: 'runtime',
    title: 'ctx.check',
    sub: ['reads scope-local tables only', 'absent or empty projection = deny'],
  },
];

export const caption =
  'The branch off the top ends in a person: PERMISSIONS.md exists to be read in a diff, and CI ' +
  'going red is what makes the reading unskippable — it is not itself the approval.';

export function alt(): string {
  return [
    '**Diagram — a permission, from declaration to check.**',
    '',
    `1. **${source.title}** (${source.tag}) — ${source.sub.join('; ')}.`,
    `   - Branches off to **${review.title}** (${review.tag}), which ${toReview} ` +
      `${review.sub.join('; ')}. This branch ends in a human review, not at runtime.`,
    ...stages.map(
      (s, i) => `${i + 2}. *${s.edge}* → **${s.title}** (${s.tag}) — ${s.sub.join('; ')}.`,
    ),
    '',
    caption,
  ].join('\n');
}
