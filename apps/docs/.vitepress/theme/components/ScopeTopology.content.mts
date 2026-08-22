/**
 * The adapter-neutral topology, and its markdown twin.
 *
 * Replaces the `flowchart TB` mermaid block that stood in guide/architecture.md.
 * Mermaid laid it out on its own terms — box widths from label length, edges
 * routed by dagre — so the one thing the picture is for, that a scope host fans
 * out to many isolated scopes and every one of them feeds the same spine, came
 * out looking accidental.
 *
 * This is deliberately NOT the hosted picture: no router, no Cloudflare, no
 * Durable Objects. That is `RuntimeTopology`, further down the same page. The
 * claim here is true of every adapter, which is the point of drawing it first.
 *
 * Same contract as the sibling content modules: a fact typed into the template
 * renders on the page and vanishes from llms.txt. Put it here.
 */

export const aria =
  'Vertical code reaches a scope host through the kernel API only. The host hands out ' +
  'capability stubs for individual scopes, each with its own database and ACL and its own ' +
  'serialized executor. Every scope emits kernel-stamped events into one shared event spine.';

export const vertical = {
  tag: 'your code',
  title: 'Vertical',
  sub: 'TypeScript · often AI-built',
} as const;

export const toHost = '@substrat-run/kernel API only';

export const host = {
  tag: 'kernel',
  title: 'Scope host',
  mono: 'getScope(principal, tenant, scope)',
} as const;

export const toScopes = 'holding a stub is the authorization';

export const scopes = [
  {
    tag: 'one isolation domain',
    title: 'Scope · branch #1',
    sub: ['its own database + ACL', 'serialized — one op at a time'],
  },
  {
    tag: 'one isolation domain',
    title: 'Scope · branch #240',
    sub: ['its own database + ACL', 'serialized — one op at a time'],
  },
] as const;

export const toSpine = 'events, kernel-stamped';

export const spine = {
  tag: 'kernel-owned',
  title: 'Event spine',
  sub: 'audit · reporting · integrations',
} as const;

export const caption =
  'The same shape on every adapter — one SQLite file per scope locally, one Durable Object ' +
  'per scope in production. Nothing above the stub can widen its own reach.';

/**
 * The twin. It does not restate the three invariants below the figure on the
 * page: those are prose the twin already carries verbatim, and saying them twice
 * is how two copies start disagreeing.
 */
export function alt(): string {
  return [
    '**Diagram — the topology, adapter-neutral.** Vertical code reaches data one way, ' +
      'and every scope feeds one spine.',
    '',
    `1. **${vertical.title}** (${vertical.tag}, ${vertical.sub}) reaches the host by ` +
      `**${toHost}**.`,
    `2. **${host.title}** (${host.tag}) — \`${host.mono}\` returns a capability stub. ` +
      `${toScopes}.`,
    `3. Each scope is ${scopes[0].sub.join(', ')} — drawn here as ` +
      `${scopes.map((s) => s.title).join(' and ')}, but there are as many as the tenant has.`,
    `4. Every scope emits **${toSpine}** into the **${spine.title}** (${spine.tag}): ` +
      `${spine.sub}.`,
    '',
    caption,
  ].join('\n');
}
