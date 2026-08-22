/**
 * What a hostname actually serves, and which part of that is allowed to move.
 *
 * The page's whole argument is that an instance is `(scope × version)` and that
 * exactly one of the three primitives is mutable. Read as prose it is four
 * sections; drawn, it is one lookup with a table of what moves the binding.
 *
 * This is the mechanism behind #527, where a preview inherited `serving_ref` and
 * therefore served production code. A picture that puts the mutable link in the
 * middle is the point.
 *
 * Same contract as the sibling content modules: a fact typed into the template
 * renders on the page and vanishes from llms.txt. Put it here.
 */

export const aria =
  'A hostname resolves to a scope, never to a version. The scope is bound to a version id, ' +
  'and that binding is the only mutable link. The version id resolves to an immutable ' +
  'deploymentRef. Prod, test and preview differ only in what moves the binding.';

export const chain = [
  {
    tag: 'stable',
    title: 'Hostname',
    sub: 'names a scope, never a version',
    git: 'a checkout path',
    mutable: false,
  },
  {
    tag: 'the thing that is named',
    title: 'Scope',
    sub: 'one isolation domain, one database',
    git: '—',
    mutable: false,
  },
  {
    tag: 'immutable',
    title: 'Version id → deploymentRef',
    sub: 'a pushed build never changes',
    git: 'a commit sha',
    mutable: false,
  },
] as const;

export const edges = ['resolves to', 'currently bound to'] as const;

/** The one mutable link, and the only thing that distinguishes an environment. */
export const binding = {
  title: 'the binding',
  detail: 'bindScopeVersion — mutable by design',
  git: 'a branch ref',
} as const;

export const environments = [
  ['prod', 'an explicit, acknowledged promote — cascades across a shared vertical’s tenants'],
  ['test', 'every merge to main, one scope, ungated, driven from CI'],
  ['preview', 'each push to the PR — its own scope, so it can never inherit prod’s binding'],
] as const;

export const caption =
  'Nothing else names an environment. “prod” and “test” are the same shape — a stable scope and ' +
  'a stable hostname whose binding moves; only the trigger and how gated it is differ.';

export function alt(): string {
  return [
    '**Diagram — what a hostname serves.** An instance is `(scope × version)`, and exactly one ' +
      'link in the chain is mutable.',
    '',
    `1. **${chain[0].title}** (${chain[0].tag}, ${chain[0].git}) — ${chain[0].sub}.`,
    `2. *${edges[0]}* → **${chain[1].title}** — ${chain[1].sub}.`,
    `3. *${edges[1]}* — this is **${binding.title}** (${binding.git}): ${binding.detail}. ` +
      'It is the only mutable link, and the only thing an environment is.',
    `4. → **${chain[2].title}** (${chain[2].tag}, ${chain[2].git}) — ${chain[2].sub}.`,
    '',
    '**What moves the binding:**',
    ...environments.map(([env, trigger]) => `- **${env}** — ${trigger}.`),
    '',
    caption,
  ].join('\n');
}
