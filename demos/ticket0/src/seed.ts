/**
 * The world the scenario replays against — harness code, so `node:*` is fine here
 * and never in module code.
 *
 * Two desks, always. Kestrel exists to be attacked: isolation you can only describe
 * is isolation you have not proved.
 *
 * The one thing seeded that an operation could not do itself is the GRANT on a
 * customer's own contact. That is deliberate and it is the same bootstrap todo has:
 * `ctx.grant` DELEGATES — the kernel re-checks that the caller already holds what it
 * is handing out — so nobody can grant themselves access to a conversation that did
 * not exist a moment ago. It is a platform actor's act, once, per person.
 *
 * The two `assistant` roles are the whole design in one place: same account shape,
 * same code path, and the only difference between a desk where the AI talks to
 * customers and one where it drafts for review is which of them its account holds.
 */
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { principalId, platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import { T0_PERM, ticket0Manifest } from './manifest.js';
import { ASSISTANT_NAME } from './module.js';
// The module set and the role table live in `provision.ts` — the ONE place both this
// node host and the deployed worker read them from. See the note at its head.
import { MODULES, ROLES } from './provision.js';
import { DEV_PROVIDER, PERSONAS } from './personas.js';

export { MODULES, ROLES };

export interface Person {
  readonly name: string;
  readonly email: string;
  readonly principal: ReturnType<typeof principalId.parse>;
}

export interface Desk {
  readonly tenant: ReturnType<typeof tenantId.parse>;
  readonly scope: ReturnType<typeof scopeId.parse>;
  readonly admin: Person;
  readonly agent: Person;
  readonly assistant: Person;
  readonly customer: Person;
  readonly relay: Person;
  /** The principal the embedded widget runs as. Holds one key and nothing else. */
  readonly widget: Person;
  /** The identity-verification secret, so the harness can sign like a host page. */
  readonly verificationSecret: string;
  /** The customer's contact row, once they have appeared. */
  readonly customerContactId: string;
  readonly origin: string;
  /**
   * Where this desk is embeddable in development — real cross-origin callers.
   *
   * Plural because Substrat's desk has two: the actual documentation site, and the
   * stand-in page the demo serves so the widget can be seen without starting it.
   */
  readonly devOrigins: readonly string[];
}

export interface World {
  readonly staff: ReturnType<typeof platformActorId.parse>;
  /** Substrat's own desk. Its assistant answers customers. */
  readonly substrat: Desk;
  /** Kestrel's desk. Its assistant drafts and a human sends. */
  readonly kestrel: Desk;
}

export function buildHost(dir: string): ScopeHost {
  const host = new SqliteScopeHost({ dir });
  for (const m of MODULES) host.registerModule(m);
  return host;
}

/** Principal ids are ULID-minted; readability lives in `name`, never in the id. */
const person = (name: string, email: string): Person => ({
  name,
  email,
  principal: principalId.parse(ulid()),
});

/**
 * Sign an external id the way a customer's own web server would.
 *
 * This is the harness standing in for the host page's backend: HMAC-SHA256 over the
 * user id, keyed by the desk's secret. Web Crypto, so it is the same call the module
 * makes to verify it.
 */
export async function signIdentity(secret: string, externalId: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(externalId));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

interface DeskSpec {
  readonly slug: string;
  readonly name: string;
  readonly origin: string;
  readonly devOrigins: readonly string[];
  readonly fromAddress: string;
  readonly docsUrl: string;
  readonly docsLabel: string;
  /** Which assistant role this desk hands its AI. The entire policy difference. */
  readonly assistantRole: 'assistant' | 'assistant-autonomous';
  readonly admin: Person;
  readonly agent: Person;
  readonly assistant: Person;
  readonly customer: Person;
  readonly relay: Person;
  readonly widget: Person;
  readonly articles: { url: string; title: string; headingPath: string; body: string }[];
  readonly inbox: InboxSeed[];
  readonly savedReplies?: { title: string; body: string }[];
}

/** One conversation's worth of history, played through the ordinary operations. */
interface InboxSeed {
  readonly key: string;
  readonly from: string;
  readonly name: string;
  readonly subject: string;
  readonly body: string;
  readonly draft?: string;
  readonly confidence?: number;
  /** What the assistant searched for — so the seeded draft cites something real. */
  readonly cite?: string;
  readonly tokens?: [number, number];
  readonly note?: string;
  readonly reply?: string;
  readonly assign?: boolean;
  readonly resolve?: boolean;
  readonly reopen?: string;
}


/**
 * A desk with some history in it.
 *
 * A demo whose inbox holds one empty conversation shows the layout and none of the
 * product: the states that matter (a draft awaiting a human, an internal note the
 * customer must not see, a resolved thread a reply reopened) only exist once somebody
 * has done the work. So the seed does the work, through the ordinary operations.
 */
async function populate(
  host: ScopeHost,
  ctx: { tenant: ReturnType<typeof tenantId.parse>; scope: ReturnType<typeof scopeId.parse>; spec: DeskSpec },
): Promise<void> {
  const { tenant, scope, spec } = ctx;
  const relay = await host.getScope(spec.relay.principal, tenant, scope);
  const agent = await host.getScope(spec.agent.principal, tenant, scope);
  const assistant = await host.getScope(spec.assistant.principal, tenant, scope);

  const inbound = async (
    from: string,
    name: string,
    subject: string,
    body: string,
    key: string,
  ) =>
    (await relay.invoke('ticket0/ingest-message', {
      conversationId: null,
      contactEmail: from,
      contactName: name,
      subject,
      bodyText: body,
      emailMessageId: `<${key}@mail.example>`,
    })) as { id: string; conversation_id: string };

  /**
   * A desk with no history, for when you want to watch one accumulate.
   *
   * The sample inbox exists so the screens have something to show — the states that
   * matter (a draft awaiting a human, an internal note, a reopened thread) only exist
   * once somebody has done the work. But it is invented, and when you are testing your
   * own conversation it is just noise in front of it.
   */
  if (process.env.TICKET0_EMPTY === '1') return;

  for (const c of spec.inbox) {
    const m = await inbound(c.from, c.name, c.subject, c.body, c.key);

    if (c.draft) {
      // Real citations, found the way the assistant finds them — so the draft card
      // shows sources a reviewer can actually open rather than an empty list.
      const found = (await assistant.invoke('ticket0/search-kb', {
        q: c.cite ?? c.subject.split(' ').slice(0, 2).join(' '),
        limit: 2,
      })) as { results: { id: string }[] };

      // A drafted answer waiting for a human — artboard 04.
      await assistant.invoke('ticket0/record-answer', {
        conversationId: m.conversation_id,
        turnId: `${c.key}-turn`,
        model: 'claude-sonnet-5',
        body: c.draft,
        inputTokens: c.tokens?.[0] ?? 1180,
        outputTokens: c.tokens?.[1] ?? 240,
        citedArticleIds: found.results.map((r) => r.id),
        confidence: c.confidence ?? 0.91,
        outcome: 'drafted',
      });
    }
    if (c.note) await agent.invoke('ticket0/post-note', { conversationId: m.conversation_id, body: c.note });
    if (c.assign) await agent.invoke('ticket0/assign', { conversationId: m.conversation_id, assignee: spec.agent.principal });
    if (c.reply) await agent.invoke('ticket0/post-public-reply', { conversationId: m.conversation_id, body: c.reply });
    if (c.resolve) await agent.invoke('ticket0/resolve', { conversationId: m.conversation_id });
    if (c.reopen) {
      // Artboard 08: the customer writes again and the thread comes back.
      await relay.invoke('ticket0/ingest-message', {
        conversationId: m.conversation_id,
        contactEmail: c.from,
        subject: `Re: ${c.subject}`,
        bodyText: c.reopen,
        emailMessageId: `<${c.key}-2@mail.example>`,
      });
    }
  }

  for (const r of spec.savedReplies ?? []) {
    await agent.invoke('ticket0/create-saved-reply', r);
  }
}

async function seedDesk(
  host: ScopeHost,
  staff: ReturnType<typeof platformActorId.parse>,
  spec: DeskSpec,
): Promise<Desk> {
  const tenant = tenantId.parse(ulid());
  const scope = scopeId.parse(ulid());

  await host.admin.createTenant(staff, { id: tenant, slug: spec.slug, name: spec.name });
  await host.admin.grantEntitlement(staff, tenant, ticket0Manifest.entitlementKey as string);
  await host.provisionScope(staff, { tenantId: tenant, scopeId: scope, vertical: 'ticket0' });
  await host.admin.activateScope(staff, tenant, scope);
  for (const role of ROLES) await host.admin.defineRole(staff, tenant, role);

  const node = { tenantId: tenant, scopeId: scope };
  const assign = (p: Person, roleKey: string) =>
    host.admin.assignRole(staff, { principalId: p.principal, roleKey, node });

  await assign(spec.admin, 'desk-admin');
  await assign(spec.agent, 'agent');
  // The one line that decides whether this desk's AI talks to customers.
  await assign(spec.assistant, spec.assistantRole);
  await assign(spec.customer, 'customer');
  await assign(spec.relay, 'relay');
  await assign(spec.widget, 'widget');

  // --- The desk, set up through its own operations ---------------------------
  const adminStub = await host.getScope(spec.admin.principal, tenant, scope);
  const rotated = (await adminStub.invoke('ticket0/rotate-verification-secret', {})) as {
    secret: string;
  };
  await adminStub.invoke('ticket0/configure-desk', {
    fromAddress: spec.fromAddress,
    greeting: `Hi - ${spec.name} support here. What can we help with?`,
    // Both: the canonical site, and the demo's stand-in for it. An origin the desk
    // has not listed is refused at the door, which is what the demo shows.
    allowedOrigins: [spec.origin, ...spec.devOrigins],
  });

  // Prices, so the cost view has something to render. Per token, which is why they
  // are decimal strings: 0.000003 is not a number a float should be asked to hold.
  await adminStub.invoke('ticket0/set-usage-rate', {
    meterKey: 'ai.tokens.input',
    unitPrice: '0.000003',
    currency: 'EUR',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
  });
  await adminStub.invoke('ticket0/set-usage-rate', {
    meterKey: 'ai.tokens.output',
    unitPrice: '0.000015',
    currency: 'EUR',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
  });

  // --- The knowledge base ----------------------------------------------------
  const source = (await adminStub.invoke('ticket0/add-kb-source', {
    kind: 'llms-txt',
    url: spec.docsUrl,
    label: spec.docsLabel,
  })) as { id: string };
  await adminStub.invoke('ticket0/ingest-kb-source', { sourceId: source.id });
  // Standing in for the connector that would fetch and parse. The operation is the
  // same one the connector calls; only the fetching is missing.
  await adminStub.invoke('ticket0/record-kb-articles', {
    sourceId: source.id,
    articles: spec.articles,
  });

  // --- Staff profiles: the source of every human-readable name on outbound mail --
  const agentStub = await host.getScope(spec.agent.principal, tenant, scope);
  await agentStub.invoke('ticket0/set-agent-profile', {
    displayName: spec.agent.name,
    avatarUrl: null,
    signature: `${spec.agent.name}\n${spec.name} Support`,
  });
  const assistantStub = await host.getScope(spec.assistant.principal, tenant, scope);
  await assistantStub.invoke('ticket0/set-agent-profile', {
    displayName: ASSISTANT_NAME,
    avatarUrl: null,
    signature: null,
  });

  // --- The customer appears, vouched for by their own site -------------------
  // Opened by the WIDGET service, the way an embedded chat would: the customer's own
  // principal is a portal concern and plays no part in the widget at all.
  const signature = await signIdentity(rotated.secret, spec.customer.email);
  const widgetStub = await host.getScope(spec.widget.principal, tenant, scope);
  const started = (await widgetStub.invoke('ticket0/widget-start', {
    origin: spec.origin,
    identity: {
      externalId: spec.customer.email,
      email: spec.customer.email,
      displayName: spec.customer.name,
      signature,
    },
  })) as { conversationId: string };

  const conversation = (await agentStub.invoke('ticket0/get-conversation', {
    conversationId: started.conversationId,
  })) as { contact_id: string };

  /**
   * The PORTAL grant — what a signed-in customer gets, and nothing the widget needs.
   *
   * Made once per person on their own contact, by a platform actor, because
   * `ctx.grant` delegates what the caller already holds and nobody holds anything on
   * a contact that did not exist a moment ago. Their conversations are reached from
   * it through the declared parent edge, and nobody else's are reachable at all.
   *
   * In a real deployment this is made when the person first signs in. It is not on
   * the widget path: a stranger in a chat bubble never needs one.
   */
  {
    await host.admin.grant(staff, {
      principalId: spec.customer.principal,
      permission: T0_PERM.conversationReadOwn,
      node,
      entity: { entityType: 'contact', entityId: conversation.contact_id },
      grantedBy: spec.customer.principal,
    });
  }

  await populate(host, { tenant, scope, spec });

  return {
    tenant,
    scope,
    admin: spec.admin,
    agent: spec.agent,
    assistant: spec.assistant,
    customer: spec.customer,
    relay: spec.relay,
    widget: spec.widget,
    verificationSecret: rotated.secret,
    customerContactId: conversation.contact_id,
    origin: spec.origin,
    devOrigins: spec.devOrigins,
  };
}

/**
 * Substrat's inbox. Real questions about deploying software, answered out of the real
 * documentation — the handoff is explicit that placeholder copy is not acceptable here.
 */
const SUBSTRAT_INBOX: InboxSeed[] = [
  {
    key: 'preview-env',
    from: 'marcus@parcelbay.com',
    name: 'Marcus Lindqvist',
    subject: 'Preview environment keeps serving production code',
    body:
      'We opened a PR and the preview URL came up, but it is clearly running what is on ' +
      'main — our new endpoint 404s. Have we wired something wrong?',
    draft:
      'A preview must not inherit the scope’s serving_ref: the router resolves\n' +
      '  COALESCE(scope.serving_ref, version.deployment_ref)\n' +
      'so a preview that carries a serving_ref serves production code instead of the ' +
      'PR’s. Clear it on the preview scope and the router falls through to the version ' +
      'the PR deployed.',
    confidence: 0.91,
    tokens: [1180, 240],
    cite: 'permiss',
    note: 'Parcelbay are on the enterprise plan — escalate if this drags past today.',
    assign: true,
  },
  {
    key: 'cli-version',
    from: 'elena@parcelbay.com',
    name: 'Elena Sørensen',
    subject: 'substrat push keeps bumping the version past package.json',
    body:
      'Every push lands a patch above what our package.json says. Is there a way to make ' +
      'push use our version rather than the registry’s?',
    reply:
      'Yes — pass it explicitly. By default push takes the registry’s highest semver and ' +
      'patch-bumps it, so package.json drifts within a few deploys. Let changesets own ' +
      'the version and run:\n\n  substrat push --version $(node -p "require(\'./package.json\').version")\n\n' +
      'Read it with node -p at that point in the script, not $npm_package_version — that ' +
      'one is captured before changeset version rewrites the file.',
    assign: true,
    resolve: true,
    reopen:
      'That worked, thank you. One more: does --promote prod need a separate approval, or ' +
      'is merging enough?',
  },
  {
    key: 'scope-migrate',
    from: 'toby@northwindtools.example',
    name: 'Toby Almqvist',
    subject: 'Can I edit a migration that already shipped?',
    body: 'We got a column name wrong in 0004. Can we just fix it in place before the next release?',
    draft:
      'No — a shipped migration has already run against every scope that applied it, so ' +
      'editing it changes only what future scopes get and leaves the two permanently ' +
      'disagreeing. Append a new migration that renames the column instead. The journal ' +
      'is the record; the generated module is rendered from it.',
    confidence: 0.88,
    tokens: [960, 180],
    cite: 'migrat',
  },
  {
    key: 'tenant-isolation',
    from: 'priya@customer.example',
    name: 'Priya Raman',
    subject: 'How is cross-tenant access actually prevented?',
    body:
      'Our security review is asking whether a bug in our code could read another tenant’s ' +
      'rows. What is the honest answer?',
    reply:
      'One scope is one isolated database, and ctx.sql cannot reach another — there is no ' +
      'cross-tenant API to misuse, so it is not a query you have to remember to scope. The ' +
      'boundary is the store, not a WHERE clause.',
    assign: true,
    resolve: true,
  },
  {
    key: 'seats',
    from: 'ops@harbourline.example',
    name: 'Jonas Petersen',
    subject: 'Is there a free tier?',
    body: 'Evaluating for a small team — three of us. What does that cost?',
  },
];

const SUBSTRAT_SAVED_REPLIES = [
  {
    title: 'Cert still issuing',
    body:
      'The certificate for your custom domain is still issuing — that usually completes ' +
      'within fifteen minutes of the CNAME resolving. I’ll keep an eye on it and write ' +
      'back the moment it goes live.',
  },
  {
    title: 'Ask for a request id',
    body:
      'Could you send the request id from the response headers (x-substrat-ray)? That ' +
      'lets me find the exact request rather than guessing from the timestamp.',
  },
];

const KESTREL_INBOX: InboxSeed[] = [
  {
    key: 'export-fail',
    from: 'sam@driftwood.example',
    name: 'Sam Okonjo',
    subject: 'Scheduled export failed overnight',
    body: 'The 02:00 export to S3 did not arrive and there is nothing in the activity log.',
    draft:
      'Exports over 50 MB are split into parts, and a part that fails is retried without ' +
      'a new activity entry — which is why the log looks empty. Check the destination for ' +
      'partial objects and re-run the export from the dashboard.',
    confidence: 0.74,
    tokens: [640, 150],
    cite: 'export',
    assign: true,
  },
  {
    key: 'key-rotate',
    from: 'devs@driftwood.example',
    name: 'Ana Ruiz',
    subject: 'Rotating an API key without downtime',
    body: 'If we rotate, does the old key stop working immediately?',
    draft:
      'No — rotating issues a new secret and keeps the old one valid for 24 hours, so a ' +
      'deploy can pick up the new value without downtime. Revoke immediately only if you ' +
      'believe the old key leaked.',
    confidence: 0.86,
    tokens: [520, 120],
    cite: 'rotat',
  },
];

/** A few real pages, so the assistant has something true to cite. */
const SUBSTRAT_ARTICLES = [
  {
    url: 'https://substrat.net/concepts/model',
    title: 'The model',
    headingPath: 'Concepts > The model',
    body:
      "A vertical's model is one TypeScript module declaring what exists: its entities, " +
      'the operations over them, and the permissions those operations check. It is not a ' +
      'schema language. It is TypeScript, because the compiler is what checks the joins ' +
      'between those three things, and those joins are where the defects live.',
  },
  {
    // `concepts/migrations` does not exist — migrations are a section of the modules
    // page. An invented URL in a citation is worse than no citation: it is a 404 with
    // our name on it, handed to a customer as an answer.
    url: 'https://substrat.net/concepts/modules#migrations',
    title: 'Migrations against a live scope',
    headingPath: 'Modules & the manifest > Migrations',
    body:
      'Migrations are an append-only ordered list, journaled per module and applied lazily ' +
      'per scope. A shipped migration is never edited: its old text has already run against ' +
      'every scope that applied it. To change a table, append a new migration. Version ' +
      'updates deploy in place and data carries forward.',
  },
  {
    url: 'https://substrat.net/concepts/permissions',
    title: 'Permissions and the proof path',
    headingPath: 'Concepts > Permissions',
    body:
      'Every permission decision carries a proof path recording why it was allowed and ' +
      'which grant allowed it. Grants can be narrowed to a single entity, and the walk ' +
      'follows declared parent edges, so access to a child is decided by a grant on its ' +
      'parent rather than by a WHERE clause somebody remembered to write.',
  },
];

const KESTREL_ARTICLES = [
  {
    url: 'https://docs.kestrel.example/exports',
    title: 'Scheduling an export',
    headingPath: 'Guides > Exports',
    body:
      'Exports run on a schedule you set per dashboard. A scheduled export delivers to ' +
      'email or an S3 bucket. Exports larger than 50 MB are split into parts.',
  },
  {
    url: 'https://docs.kestrel.example/api-keys',
    title: 'Rotating an API key',
    headingPath: 'Guides > API keys',
    body:
      'Rotating a key issues a new secret and keeps the old one valid for 24 hours, so a ' +
      'deploy can pick up the new value without downtime. Revoke immediately if leaked.',
  },
];

export async function seed(host: ScopeHost): Promise<World> {
  const staff = platformActorId.parse(ulid());

  const substrat = await seedDesk(host, staff, {
    slug: 'substrat-support',
    name: 'Substrat',
    origin: 'https://substrat.net',
    /**
     * Two, and they are different things.
     *
     * `:5173` is the REAL documentation site — `TICKET0_WIDGET=1 pnpm --filter
     * @substrat-run/docs dev` puts this desk's widget on it, answering out of the same
     * corpus the site publishes. That is the dogfood.
     *
     * `:5279` is the stand-in page this demo serves, so the widget can be seen working
     * without starting a second project. Same desk, same knowledge base, same
     * assistant — only the scenery around it is invented.
     */
    devOrigins: ['http://localhost:5173', 'http://localhost:5279'],
    fromAddress: 'support@substrat.net',
    // The real corpus. `ticket0/ingest-kb-source` emits, the harness ingester fetches
    // and parses, and the assistant answers out of the actual Substrat documentation.
    docsUrl: 'https://substrat.net/llms-full.txt',
    docsLabel: 'Substrat documentation',
    // This desk lets the assistant answer.
    assistantRole: 'assistant-autonomous',
    admin: person('Markus', 'markus@substrat.example'),
    agent: person('Anna', 'anna@substrat.example'),
    assistant: person(ASSISTANT_NAME, 'assistant@substrat.example'),
    customer: person('Priya', 'priya@customer.example'),
    relay: person('Email relay', 'relay@substrat.example'),
    widget: person('Widget service', 'widget@substrat.example'),
    articles: SUBSTRAT_ARTICLES,
    inbox: SUBSTRAT_INBOX,
    savedReplies: SUBSTRAT_SAVED_REPLIES,
  });

  const kestrel = await seedDesk(host, staff, {
    slug: 'kestrel-support',
    name: 'Kestrel Analytics',
    origin: 'https://kestrel.example',
    // No page of its own. Kestrel is the supervised desk and it earns its keep in the
    // tests and in the inbox (sign in as Dana or Omar); a second stand-in site to watch
    // an assistant NOT answer was scenery for a negative.
    devOrigins: [],
    fromAddress: 'support@kestrel.example',
    docsUrl: 'https://docs.kestrel.example/llms.txt',
    docsLabel: 'Kestrel documentation',
    // This one does not. A human sends every outbound word.
    assistantRole: 'assistant',
    admin: person('Dana', 'dana@kestrel.example'),
    agent: person('Omar', 'omar@kestrel.example'),
    assistant: person(ASSISTANT_NAME, 'assistant@kestrel.example'),
    customer: person('Tomas', 'tomas@othercustomer.example'),
    relay: person('Email relay', 'relay@kestrel.example'),
    widget: person('Widget service', 'widget@kestrel.example'),
    articles: KESTREL_ARTICLES,
    inbox: KESTREL_INBOX,
  });

  return { staff, substrat, kestrel };
}

/**
 * Bind each dev persona's OIDC `sub` to its principal — the ordinary identity-directory
 * seam, run on every boot rather than only on a fresh seed, because the world is cached
 * and `seed()` does not run again once it exists.
 */
export async function linkDevPersonas(host: ScopeHost, world: World): Promise<void> {
  await host.admin.registerIdentityPool(world.staff, {
    provider: DEV_PROVIDER,
    topology: 'central',
    tenantId: null,
  });
  const homes: Record<string, { person: Person; desk: Desk }> = {
    'dev|markus': { person: world.substrat.admin, desk: world.substrat },
    'dev|anna': { person: world.substrat.agent, desk: world.substrat },
    'dev|priya': { person: world.substrat.customer, desk: world.substrat },
    'dev|dana': { person: world.kestrel.admin, desk: world.kestrel },
    'dev|omar': { person: world.kestrel.agent, desk: world.kestrel },
  };
  for (const persona of PERSONAS) {
    const home = homes[persona.sub];
    if (!home) continue;
    await host.admin.linkIdentity(world.staff, {
      provider: DEV_PROVIDER,
      externalId: persona.sub,
      principal: home.person.principal,
      tenantId: home.desk.tenant,
      scopeId: home.desk.scope,
    });
  }
}
