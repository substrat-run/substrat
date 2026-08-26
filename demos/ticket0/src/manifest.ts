/**
 * ticket0's declarative surface — assembled, not written.
 *
 * Both halves come from `spec/model.ts`: `manifestOperations` reads the permission
 * keys and emitted events off the operations, `manifestEntities` reads the parent
 * edges off the entities. What is left here is what is genuinely a fact about this
 * deployment rather than about the app.
 *
 * Permission descriptions are prose, so they are supplied rather than derived — and
 * they are the text a human reads at the permission checkpoint, so they say what the
 * key lets someone DO, not what it is called.
 */
import {
  listsDeclaredBy,
  manifestEntities,
  manifestOperations,
  moduleManifest,
  permissionKey,
  type EnvVarSpec,
} from '@substrat-run/contracts';
import { ticket0Entities, ticket0Operations } from '../spec/model.js';

export const T0_PERM = {
  conversationRead: permissionKey.parse('conversation:read'),
  conversationWidget: permissionKey.parse('conversation:widget'),
  conversationReadOwn: permissionKey.parse('conversation:read-own'),
  conversationDraft: permissionKey.parse('conversation:draft'),
  conversationReplyPublic: permissionKey.parse('conversation:reply-public'),
  conversationAssign: permissionKey.parse('conversation:assign'),
  conversationResolve: permissionKey.parse('conversation:resolve'),
  conversationMerge: permissionKey.parse('conversation:merge'),
  conversationRelay: permissionKey.parse('conversation:relay'),
  contactRead: permissionKey.parse('contact:read'),
  kbRead: permissionKey.parse('kb:read'),
  kbManage: permissionKey.parse('kb:manage'),
  deskConfigure: permissionKey.parse('desk:configure'),
  usageRead: permissionKey.parse('usage:read'),
  notificationReadOwn: permissionKey.parse('notification:read-own'),
} as const;

/**
 * What a hosted install can be configured with — the dashboard's Env tab, and the
 * ONLY way the worker reads any of these. A bare `env.CF_AI_TOKEN` would read the
 * deployment-wide binding shared by every install of one serving script, so every
 * tenant would be billed against whoever set it last (#374).
 *
 * Mirrored in package.json `substrat.envSpec`, which is what `substrat push` sends —
 * the same duplication Meridian carries; no gate ties the two together yet.
 */
export const TICKET0_ENV: EnvVarSpec[] = [
  {
    key: 'AUTH_PROVIDER',
    label: 'Auth provider',
    description:
      "OIDC-only: the desk runs no credential store. When no per-scope `substrat:auth` choice is delivered, 'oidc' verifies bearer tokens against OIDC_ISSUER (standalone deploys); anything else leaves the instance without a configured issuer.",
    placeholder: 'oidc',
    default: 'oidc',
    required: false,
    secret: false,
    group: 'Auth',
  },
  {
    key: 'OIDC_ISSUER',
    label: 'OIDC issuer',
    description:
      "The issuer URL bearer tokens are verified against when the provider is 'oidc'. Covers Supabase, Auth0, AuthHero, Keycloak, …",
    placeholder: 'https://auth.example.com',
    required: false,
    secret: false,
    group: 'Auth',
  },
  {
    key: 'OIDC_AUDIENCE',
    label: 'OIDC audience',
    description: 'Expected `aud` claim of verified bearer tokens (optional; issuer-dependent).',
    placeholder: 'https://api.example.com',
    required: false,
    secret: false,
    group: 'Auth',
  },
  /**
   * The assistant's model. Absent, the desk still works: `modelFromEnv` falls back to
   * the extractive model, which retrieves the best-matching section and quotes it,
   * labelled `offline/extractive` so a turn record can never be mistaken for a
   * generated answer. That is why neither of these is `required` — a desk with no
   * model credential is a supported configuration, not a broken install.
   */
  {
    key: 'CF_ACCOUNT_ID',
    label: 'Cloudflare account id',
    description:
      'The account whose Workers AI runs the assistant. Without it (or without the token) answers are extractive quotes from the knowledge base rather than generated prose.',
    placeholder: '0123456789abcdef0123456789abcdef',
    required: false,
    secret: false,
    group: 'Assistant',
  },
  {
    key: 'CF_AI_TOKEN',
    label: 'Workers AI token',
    description:
      'API token with Workers AI read/run. Billed to the account above — which is why it is per-install and never a deployment-wide binding.',
    required: false,
    secret: true,
    group: 'Assistant',
  },
  {
    key: 'TICKET0_MODEL',
    label: 'Model',
    description: 'Which Workers AI model answers. Defaults to the one `workersAiModel` picks.',
    placeholder: '@cf/meta/llama-3.1-8b-instruct',
    required: false,
    secret: false,
    group: 'Assistant',
  },
];

export const ticket0Manifest = moduleManifest.parse({
  id: '@substrat-run/demo-ticket0',
  version: '0.1.0',
  kernelContract: '^0.0.1',
  // The package root, which is where `journal.json` actually is and where
  // `tools/emit-migrations.mts` writes it. Naming a directory that does not exist
  // is the kind of thing that reads as configured until somebody goes looking.
  migrations: { journalDir: './', compatibleFrom: '0.1.0' },
  ...manifestOperations(ticket0Operations, {
    permissions: {
      'conversation:read': 'See every conversation in this desk, internal notes included',
      'conversation:widget': 'Serve the embedded chat widget — held by the desk’s widget service alone; a visitor is confined by their session token, not by this key',
      'conversation:read-own': 'See a conversation that is yours, public messages only',
      'conversation:draft': 'Write an internal note or record a drafted answer — never leaves the building',
      'conversation:reply-public': 'Send a reply the customer will receive',
      'conversation:assign': 'Assign, snooze, wake and tag a conversation',
      'conversation:resolve': 'Resolve and close a conversation',
      'conversation:merge': 'Fold one conversation into another',
      'conversation:relay': 'Bring messages in from email and read the ones going out — the relay only, no human role',
      'contact:read': 'See the people who have asked something',
      'kb:read': 'Read and search the knowledge base',
      'kb:manage': 'Add, re-read and record documentation sources',
      'desk:configure': 'Change the desk’s settings and rotate its verification secret',
      'usage:read': 'See token usage, prices and what the desk has spent',
      'notification:read-own': 'See and dismiss your own notifications',
    },
  }),
  /**
   * The knowledge base is the one thing here that is searched rather than listed,
   * and it is the assistant's whole input. `title` and `body` — not `url`, which is
   * an identifier a person never types, and not `heading_path`, which is already a
   * prefix of the title in every source we ingest.
   *
   * Nothing on `message` is indexed, deliberately. Message bodies are `erasable`, and
   * an index over an erasable field is a second copy of it that the erasure would have
   * to know about. Searching conversations is worth doing and worth doing on purpose,
   * in its own change, with that question answered.
   */
  ...manifestEntities(ticket0Entities, {
    searchables: [{ entityType: 'kbArticle', fields: ['title', 'body'] }],
  }),
  lists: listsDeclaredBy(ticket0Operations, ticket0Entities),
  entitlementKey: 'ticket0',
  envSpec: TICKET0_ENV,
  // The desk DELEGATES sign-in (manifest `requires`, #427): at install the dashboard
  // offers the tenant's `oidc-issuer` providers to bind — issuer from the provider's
  // hostname, client minted by dynamic registration, delivered as `substrat:auth`.
  // ticket0 runs no credential store at all, so this is how a hosted desk gets a
  // login; the OIDC_* envSpec above is the hand-configured fallback for an
  // externally-hosted issuer. Mirrored in `package.json` `substrat.requires`.
  requires: ['oidc-issuer'],
});
