/**
 * Every string LayerStack renders, and the markdown twin of the same facts.
 *
 * The data lives here rather than in the component's `<script setup>` for one
 * reason: `llms.mts` cannot import a `<script setup>` block, so a diagram whose
 * content exists only inside the SFC is invisible to every agent reading
 * llms.txt. With the content here, the component renders it and `alt()`
 * flattens it — one source, so the picture and its text cannot disagree.
 *
 * The rule that follows: a fact belongs in this file, never in the template.
 * A string typed straight into LayerStack.vue renders on the page and vanishes
 * from the twin, with nothing failing.
 */

/** A chip: a named thing with a one-line gloss. */
export type Chip = readonly [name: string, sub: string];

/** A band of the stack. `role` carries inline `<em>`, so the template v-htmls it. */
export interface Layer {
  readonly name: string;
  readonly role: string;
  readonly owner: string;
  readonly chips: readonly Chip[];
}

export const verticals: Layer = {
  name: 'Verticals',
  role: 'Everything a user touches — the businesses themselves.',
  owner: 'own vocabulary · screens · pricing · roles',
  chips: [
    ['Callout', 'field service'],
    ['RallyPoint', 'padel club'],
    ['Handlebar', 'bike workshop'],
    ['Kallkälla', 'coffee shop'],
    ['Meridian', 'HR'],
    ['Manyfold', 'headless CMS'],
  ],
};

export const engines: Layer = {
  name: 'Engines',
  role: 'Headless domain machinery that owns invariants. Star topology — they talk to the kernel, never to each other.',
  owner: 'own invariants · versioned · never forked',
  chips: [
    ['workorder', 'one state machine · append-only time + material'],
    ['booking', 'resource × interval × capacity · one allocation, no locks'],
    ['invoicing', 'consumes billable events · immutable once exported'],
    ['protocol', 'checklists + signed docs · freeze → immutable, hashed'],
    ['invites', 'hashed identifier · accept-required · non-enumerable'],
  ],
};

export const adapters: Layer = {
  name: 'Adapters',
  role: 'Scope hosts — the interchangeable ground the kernel is seated on.',
  owner: 'swappable · escrowable · self-hostable',
  chips: [
    ['adapter-sqlite', 'dev · CI · self-host / escrow'],
    ['adapter-cloudflare', 'production · Durable-Object per scope'],
    ['adapter-email', 'notification transport · CF Email + mock'],
  ],
};

export const connectors: Layer = {
  name: 'Connectors',
  role: 'The outside world, at the edges. React to events on the spine — host code, never module code.',
  owner: 'no fetch inside a module — ever',
  chips: [
    ['Scrive eSign', 'signatures-requested → BankID signing → recorded back'],
    ['…more', 'one port per capability'],
  ],
};

export const kernel = {
  name: 'Kernel',
  role: 'The substrate. Everything true of <em>every</em> B2B SaaS — and nothing true of any one.',
  owner: 'owns no domain entities',
  bits: [
    'Identity', 'Nested tenancy', 'Permissions + grants', 'Events / audit spine',
    'Migrations', 'GDPR machinery', 'Notifications', 'Jobs',
    'Billing entitlements', 'Module system', 'Attachment contracts', 'App shell',
  ],
  ctxLabel: 'Every operation runs inside',
  ctx: ['ctx.sql', 'ctx.check', 'ctx.emit', 'ctx.link'],
  note: 'No customer table, no work-order table. It offers attachment contracts that bind to opaque (entityType, entityId) refs the vertical defines.',
} as const;

/** The dashed rule between "mistakes are cosmetic" and "mistakes are catastrophic". */
export const theLine = {
  label: 'the line',
  above: 'AI velocity — mistakes are cosmetic (a wrong screen)',
  below: 'humans + runtime guarantees — mistakes are catastrophic (a tenant leak)',
} as const;

/** The joins between bands, in stack order. */
export const seams = {
  verticalToEngine: 'composes engines in-scope, same transaction',
  engineToKernel: '<b>&darr;</b> ctx (sql · check · emit · link) &nbsp;·&nbsp; events + audit <b>&uarr;</b>',
  kernelToAdapter: 'same kernel semantics on any ground — one contract-test suite gates them all',
} as const;

export const lawsHead = 'The four rules that hold it together';

export const laws: readonly Chip[] = [
  ['Kernel owns no domain entities.', 'It provides the spine; verticals define what the entities mean.'],
  ['Star topology.', 'Engines cooperate through fat events and opaque refs — never by importing each other. N contracts, not N².'],
  ['Enforced at runtime.', 'Guarantees are defaults of the substrate, not config a builder — human or AI — can get wrong.'],
  ['No forking.', 'If a vertical ever needs to fork an engine, the engine drew its line wrong.'],
];

/** Markup and entities the diagram wants and the twin does not. */
const plain = (html: string) =>
  html
    .replace(/<\/?(em|b|code)>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&darr;/g, '↓')
    .replace(/&uarr;/g, '↑')
    .replace(/\s+/g, ' ')
    .trim();

const band = (layer: Layer) =>
  `- **${layer.name}** — ${plain(layer.role)} *(${layer.owner})*\n` +
  layer.chips.map(([name, sub]) => `  - \`${name}\` — ${sub}`).join('\n');

/**
 * The markdown twin, rendered from the data above rather than written beside it.
 * Add an engine to `engines.chips` and it appears here; there is no second list
 * to update and no way for the two to drift.
 */
export function alt(): string {
  return [
    '**Diagram — the three-layer stack.** Six bands, top to bottom: verticals, ' +
      'the line, engines, the kernel, the adapters under it, and connectors at the edge.',
    '',
    band(verticals),
    `- **The line.** Above: ${theLine.above}. Below: ${theLine.below}.`,
    `  - Verticals meet engines by: ${plain(seams.verticalToEngine)}.`,
    band(engines),
    `  - Engines meet the kernel by: ${plain(seams.engineToKernel)}.`,
    `- **${kernel.name}** — ${plain(kernel.role)} *(${kernel.owner})*\n` +
      `  - Provides: ${kernel.bits.join(', ')}.\n` +
      `  - ${kernel.ctxLabel}: ${kernel.ctx.map((c) => `\`${c}\``).join(', ')}.\n` +
      `  - ${kernel.note}`,
    `  - Kernel meets the adapters by: ${plain(seams.kernelToAdapter)}.`,
    band(adapters),
    band(connectors),
    '',
    `**${lawsHead}**`,
    '',
    laws.map(([head, body], i) => `${i + 1}. **${head}** ${body}`).join('\n'),
  ].join('\n');
}
