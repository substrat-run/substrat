/**
 * What a tenant contains, and where the database boundary actually falls.
 *
 * The page carries two claims that are shapes: tenancy is a **tree**, and one
 * scope is one database is one consistency domain. Prose has to walk a reader
 * through both; a picture puts the boundary where it is and the argument is
 * over.
 *
 * `parentScopeId` is drawn because its being null is a fact about today, not
 * about the model — the column exists so deeper trees are additive rather than
 * a migration, and a diagram that omits it quietly claims the opposite.
 *
 * Same contract as the sibling content modules: a fact typed into the template
 * renders on the page and vanishes from llms.txt. Put it here.
 */

export const aria =
  'A tenant is a billing and identity boundary containing one or more scopes. Each scope is ' +
  'its own database and its own consistency domain, with its own kind, jurisdiction and bound ' +
  'vertical version. Nothing joins across the boundary between two scopes.';

export const tenant = {
  tag: 'billing · identity · the contract',
  title: 'Tenant',
  sub: 'slug · status · one Identity DO for all its people',
  note: 'Holds no operational rows of its own.',
} as const;

export const scopes = [
  { slug: 'stockholm', kind: 'branch', note: 'active · eu' },
  { slug: 'göteborg', kind: 'branch', note: 'active · eu' },
  { slug: 'malmö', kind: 'branch', note: 'provisioning' },
] as const;

export const scopeFacts = [
  'its own database — one SQLite file, or one Durable Object',
  'one operation at a time, run to completion',
  'kind is your vocabulary: brf, branch, brand, clinic…',
  'jurisdiction and bound version are fixed per scope',
] as const;

export const barrier = 'No query crosses these lines. There is no join between two scopes.';

export const deeper =
  'parentScopeId is null on every scope today. The column exists so a deeper tree is an ' +
  'addition rather than a migration.';

export const caption =
  'The tenant is who you bill and who can log in. The scope is where data lives and where ' +
  'consistency is decided — which is why isolation is a property of the substrate here, not a ' +
  'WHERE clause somebody has to remember.';

export function alt(): string {
  return [
    '**Diagram — a tenant and its scopes.**',
    '',
    `- **${tenant.title}** (${tenant.tag}) — ${tenant.sub}. ${tenant.note}`,
    `- It contains scopes: ${scopes.map((s) => `\`${s.slug}\` (${s.kind}, ${s.note})`).join(', ')}.`,
    '- Every scope is: ' + scopeFacts.join('; ') + '.',
    `- **${barrier}**`,
    `- ${deeper}`,
    '',
    caption,
  ].join('\n');
}
