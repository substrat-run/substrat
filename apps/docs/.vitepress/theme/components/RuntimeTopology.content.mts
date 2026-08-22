/**
 * Every string RuntimeTopology renders, and the markdown twin of the same facts.
 * Same contract as LayerStack.content.mts: content lives here so `llms.mts` can
 * flatten it, because a fact typed into the template renders on the page and
 * disappears from llms.txt with nothing failing.
 *
 * Sourced from the Cloudflare adapter (host.ts, route-resolver.ts, scope-do.ts,
 * control-plane-do.ts).
 */

export type DbKey = 'cp' | 'id' | 'sc';
export type StepKind = 'edge' | 'router' | 'compute';

export interface Db {
  readonly key: DbKey;
  readonly card: string;
  readonly name: string;
  readonly count: string;
  readonly items: readonly string[];
  readonly tag: string;
}

export interface Step {
  readonly n: number;
  readonly kind: StepKind;
  readonly title: string;
  readonly body: string;
  readonly mono?: string;
  readonly touches?: DbKey;
}

export const headings = {
  flow: 'How a request travels',
  dbs: 'The three databases',
  provisioning: 'How the databases get created',
} as const;

export const steps: readonly Step[] = [
  {
    n: 1, kind: 'edge',
    title: 'Browser hits a hostname',
    body: 'A tenant, a vertical, and a surface — all encoded in the name.',
    mono: 'acme.callout.substrat.run',
  },
  {
    n: 2, kind: 'router',
    title: 'The router resolves the door',
    body: 'One kernel-owned worker in front of every vertical. Its only binding is the control plane — it reads the directory to turn hostname → (tenant, scope, vertical, surface). It finds the door; it cannot open a scope even by mistake.',
    touches: 'cp',
  },
  {
    n: 3, kind: 'compute',
    title: 'Header handshake, then dispatch',
    body: 'Every client x-substrat-* header is stripped; the router asserts the resolved node plus a shared secret, then dispatches to the vertical worker. The vertical has no public route — the router is the only way in.',
  },
  {
    n: 4, kind: 'compute',
    title: 'Vertical worker resolves who you are',
    body: 'The vertical worker holds no state between requests. It resolves your session to a principal in the tenant’s own identity database.',
    touches: 'id',
  },
  {
    n: 5, kind: 'compute',
    title: 'Open the scope, run the operation',
    body: 'Gate the scope’s lifecycle & tenancy, then invoke() runs the operation inside the scope’s own SQLite, in one transaction — permission check first, mutation emits an event, the outbox drains to consumers and connectors. Roll back on any throw.',
    touches: 'sc',
  },
  {
    n: 6, kind: 'edge',
    title: 'Response travels back up',
    body: 'Back through the router, the one place that knows the tenant — so it meters the request there, one datapoint per call.',
  },
];

export const dbs: readonly Db[] = [
  {
    key: 'cp', card: 'Directory', name: 'Control-plane DB', count: 'one per environment',
    items: ['Tenant registry & scope lifecycle', 'Roles, tenant grants, entitlements', 'Hostnames, verticals & versions', 'Connections (ciphertext only)', 'The admin audit log'],
    tag: 'Knows which door — never what’s behind it. A single singleton DO.',
  },
  {
    key: 'id', card: 'Application / auth', name: 'Identity DB', count: 'one per tenant',
    items: ['Users, sessions, credentials', 'Its own auth engine, own SQLite', 'The login → principal map', 'The owner seat, set at provision'],
    tag: 'Separate DO, separate storage — one tenant’s users can’t leak to another.',
  },
  {
    key: 'sc', card: 'Business data', name: 'Scope DB', count: 'one per scope',
    items: ['The vertical’s entities & kernel spine', 'Events, outbox, entity links', 'Applied migrations', 'Scope-level grants & permissions'],
    tag: 'Where ctx.sql runs — one transaction per operation.',
  },
];

export const touchLabel: Record<DbKey, string> = {
  cp: 'reads → Control-plane DB',
  id: 'reads → Identity DB (this tenant)',
  sc: 'reads + writes → Scope DB (this scope)',
};

export const kindLabel: Record<StepKind, string> = {
  edge: 'edge', router: 'kernel worker · 1 per env', compute: 'compute',
};

/** The one idea provisioning turns on. Carries `<b>`, so the template v-htmls it. */
export const provKey =
  'The trick: <b>a Durable Object’s database springs into existence the first time you address it by id.</b> ' +
  'There is no <code>CREATE DATABASE</code> and no migration server — provisioning is just addressing a new DO ' +
  'and letting it build itself.';

export const prov: readonly (readonly [string, string])[] = [
  ['Write the directory row.', 'The coordinator records the new scope in the control plane — the door now exists, gated by the tenant.'],
  ['Address the Scope DO.', 'The moment it’s named, its SQLite is born. A lazy migration builds the kernel spine and runs the vertical’s own module migrations in order — a PITR bookmark taken before each pass.'],
  ['Project permissions in.', 'The tenant’s current roles and grants are copied into the fresh scope so it can decide access from its own storage — then the migration frontier is recorded back to the directory.'],
  ['Identity DB, likewise.', 'The tenant’s Identity DO is created on first address — tables on construction, the owner seat set at provision, waiting to be claimed by the first login.'],
];

/** The closing argument. Paragraphs carry `<b>`/`<em>`; the template v-htmls them. */
export const isolation = {
  head: 'Why the shared control plane isn’t a shared blast radius',
  paragraphs: [
    'A normal vertical runs <b>“CP-less” on the hot path</b>: it decides permissions from the scope’s <em>own</em> storage and trusts the node the router asserted — the shared control plane is <b>off the request path entirely</b>. It still owns provisioning and the audit spine, but a request serving one tenant never touches another tenant’s data, or the shared directory, to answer.',
    'The result: the same kernel guarantees, a per-tenant database, and a shared control plane whose failure can’t read or corrupt a running scope. <b>Isolation is the default, not a configuration you can forget.</b>',
  ],
} as const;


/** A residency dot: which of the three layers owns the code in this box. */
export type Layer = 'k' | 'e' | 'v';

export interface Pane {
  readonly dot: Layer;
  readonly title: string;
  readonly detail: string;
}

export interface Row {
  readonly dot: Layer;
  readonly text: string;
}

/**
 * The overview drawing above the numbered steps.
 *
 * It exists for the one thing a numbered list cannot show: the request going
 * BOTH ways. Step 6 says the response travels back up, and a reader still has to
 * assemble the round trip in their head. The dashed return path draws it.
 *
 * Its labels are deliberately short — the steps below carry the prose, and
 * `alt()` does not re-emit them. What the drawing adds, and what `alt()`
 * therefore does emit, is `residency`: which layer's code runs in which box.
 */
export const diagram = {
  aria:
    'A request travels from the browser to the router, which reads the control-plane ' +
    'Durable Object to resolve the hostname, then dispatches to the vertical worker. ' +
    'The worker reads the tenant’s Identity Durable Object and opens the Scope Durable ' +
    'Object, where the operation runs. The response returns along a dashed path back ' +
    'through the router.',
  browser: { title: 'Browser', mono: 'acme.callout.substrat.run' },
  toRouter: 'the request',
  router: {
    tag: 'cloudflare edge',
    title: 'Router',
    sub: ['One per environment.', 'Finds the door; cannot open it.'],
    chip: 'kernel only',
  },
  toControlPlane: 'hostname → node',
  controlPlane: {
    tag: 'durable object',
    title: 'Control-plane DO',
    sub: ['The directory.', 'One per environment.'],
    chip: 'kernel only',
  },
  toWorker: 'dispatch · asserts the node + ROUTER_SECRET',
  worker: {
    tag: 'worker · one per version',
    title: 'The vertical worker',
    sub: 'Your pushed bundle. No public route, no state between requests.',
  },
  toIdentity: 'session → principal',
  identity: {
    tag: 'durable object',
    title: 'Identity DO',
    sub: ['One per tenant.', 'Users, sessions, the owner seat.'],
    chip: 'kernel only',
  },
  toScope: 'getScope() · invoke()',
  scope: {
    tag: 'durable object',
    title: 'Scope DO',
    sub: 'Its own SQLite. One operation at a time.',
  },
  ret: 'response · metered at the router',
} as const;

/**
 * Which layer's code executes in which box — the fact the drawing carries that
 * the numbered steps do not. One pushed bundle; the runtime decides where each
 * part of it runs, and that split is what the boundaries are made of.
 */
export const residency = {
  intro:
    'One bundle, two execution environments. The worker is trusted with addressing ' +
    'and never with data; the scope holds the data and cannot reach the network.',
  worker: [
    { dot: 'k', title: 'Kernel host', detail: 'getScope() · permission gate · metering' },
    { dot: 'v', title: 'Vertical HTTP', detail: 'routes, error envelope, session → principal' },
    { dot: 'v', title: 'Connector code', detail: 'the only place fetch() is allowed to exist' },
  ],
  scope: [
    { dot: 'v', text: 'Vertical operations — ctx.check(), then ctx.sql' },
    { dot: 'e', text: 'Engine functions — the same transaction' },
    { dot: 'k', text: 'Kernel spine — events, outbox, links, migrations' },
  ],
} as const satisfies { intro: string; worker: readonly Pane[]; scope: readonly Row[] };

/** Markup the diagram wants and the twin does not. */
const plain = (html: string) => html.replace(/<\/?(b|em|code)>/g, '');

/**
 * The markdown twin, rendered from the data above. The numbered flow survives as
 * a numbered list because the order is the information — this really is a
 * sequence, not a set of labelled boxes.
 */
export function alt(): string {
  const flow = steps.map((s) => {
    const detail = [
      s.mono ? `\`${s.mono}\`` : '',
      s.touches ? `_${touchLabel[s.touches]}_` : '',
    ].filter(Boolean);
    return (
      `${s.n}. **${s.title}** (${kindLabel[s.kind]}) — ${s.body}` +
      (detail.length ? `\n   ${detail.join(' · ')}` : '')
    );
  });

  const stores = dbs.map(
    (d) =>
      `- **${d.name}** (${d.card}, ${d.count}) — ${d.items.join('; ')}. ${d.tag}`,
  );

  const provisioning = prov.map(([head, body], i) => `${i + 1}. **${head}** ${body}`);

  const where = [
    `- **The vertical worker** runs: ` +
      residency.worker.map((p) => `${p.title} (${p.detail})`).join('; ') + '.',
    `- **The Scope DO** runs: ` + residency.scope.map((r) => r.text).join('; ') + '.',
  ];

  return [
    '**Diagram — the hosted runtime topology.** Every box is a Durable Object with ' +
      'its own SQLite; the router’s only job is to find the right door. The request ' +
      'descends browser → router → worker → scope, and the response returns the same ' +
      'way, metered at the router.',
    '',
    residency.intro,
    '',
    ...where,
    '',
    `**${headings.flow}**`,
    '',
    ...flow,
    '',
    `**${headings.dbs}**`,
    '',
    ...stores,
    '',
    `**${headings.provisioning}**`,
    '',
    plain(provKey),
    '',
    ...provisioning,
    '',
    `**${isolation.head}**`,
    '',
    ...isolation.paragraphs.map(plain),
  ].join('\n');
}
