/**
 * This vertical's permission surface AND its module set, as a build-time fact.
 *
 * Read by the permission checkpoint (`pnpm lint:permissions`), by `substrat push`, by
 * the node dev host (`seed.ts`) and by the deployed worker (`worker.ts`) — one place,
 * so a module registered in only one of them cannot exist. That is not hypothetical:
 * `MODULES` and `ROLES` used to live in `seed.ts`, which imports `node:*` and a
 * concrete adapter, so the worker could not import them without dragging both into a
 * workerd bundle. A second copy would have run locally and silently not deployed.
 *
 * Nothing here may import a host, an adapter or `node:*` — the worker compiles this
 * file.
 */
import { definePermissions, type PermissionKey, type RoleDefinition } from '@substrat-run/contracts';
import { meteringModule, PERM as METERING_PERM } from '@substrat-run/engine-metering';
import { T0_PERM } from './manifest.js';
import { ticket0Module } from './module.js';

export const MODULES = [meteringModule, ticket0Module];

/**
 * Support staff. `conversation:read` is desk-wide here and nowhere else — an agent
 * sees the whole inbox, which is what makes the customer-side keys interesting.
 */
const AGENT_PERMISSIONS = [
  T0_PERM.conversationRead,
  T0_PERM.conversationDraft,
  T0_PERM.conversationReplyPublic,
  T0_PERM.conversationAssign,
  T0_PERM.conversationResolve,
  T0_PERM.contactRead,
  T0_PERM.kbRead,
  T0_PERM.notificationReadOwn,
];

export const ROLES: RoleDefinition[] = [
  {
    key: 'desk-admin',
    permissions: [
      ...AGENT_PERMISSIONS,
      T0_PERM.conversationMerge,
      T0_PERM.kbManage,
      T0_PERM.deskConfigure,
      // The money. Held here and in no other role.
      T0_PERM.usageRead,
      METERING_PERM.read,
      METERING_PERM.close,
      METERING_PERM.configure,
      METERING_PERM.record,
    ],
    source: 'vertical',
  },
  { key: 'agent', permissions: AGENT_PERMISSIONS, source: 'vertical' },
  /**
   * The supervised assistant. It may read the knowledge base and write a draft;
   * the draft is an internal message and cannot leave the building.
   */
  {
    key: 'assistant',
    permissions: [
      T0_PERM.conversationRead,
      T0_PERM.conversationDraft,
      T0_PERM.kbRead,
      METERING_PERM.record,
      METERING_PERM.configure,
    ],
    source: 'vertical',
  },
  /**
   * The same assistant, trusted to answer. One key more, and it is the one that
   * decides whether a customer ever hears from it directly.
   */
  {
    key: 'assistant-autonomous',
    permissions: [
      T0_PERM.conversationRead,
      T0_PERM.conversationDraft,
      T0_PERM.conversationReplyPublic,
      T0_PERM.kbRead,
      METERING_PERM.record,
      METERING_PERM.configure,
    ],
    source: 'vertical',
  },
  /**
   * A signed-in customer, in the portal. Almost nothing is held scope-wide: what
   * they can reach is a grant on their OWN contact, made once when they sign in.
   */
  {
    key: 'customer',
    permissions: [T0_PERM.notificationReadOwn],
    source: 'vertical',
  },
  /**
   * The desk's widget service — the principal the embedded chat runs as.
   *
   * ONE key, and it is deliberately not a skeleton key: it opens conversations and
   * serves the widget, and it reaches no inbox, no contact list and no money. A
   * visitor is confined by their session token rather than by anything here, so this
   * principal being on a public surface costs exactly what this row says it does.
   */
  { key: 'widget', permissions: [T0_PERM.conversationWidget], source: 'vertical' },
  /**
   * The email relay. Held by no human — a connection acts as itself, the same way
   * the Scrive connector records a signature back into a scope.
   */
  { key: 'relay', permissions: [T0_PERM.conversationRelay], source: 'vertical' },
];

/**
 * The keys reachable OUTSIDE the role table — the shapes, not the grants themselves,
 * which are per-principal ULIDs minted at runtime.
 *
 * One entry, and it is the customer side of the whole app. Nobody holds either key
 * scope-wide; each is granted to one person on their OWN contact, and their
 * conversations are reached from it through the declared parent edge. That is what
 * makes one customer's history unreachable to another.
 */
export const ENTITY_GRANTS: { entityType: string; permissions: PermissionKey[] }[] = [
  {
    entityType: 'contact',
    permissions: [T0_PERM.conversationReadOwn],
  },
];

/**
 * The role the platform grants whoever installs this vertical. `desk-admin` is the
 * only role that holds `desk:configure` — without it a fresh hosted desk could never
 * be given a from-address or an embedding allowlist, and the install would land on a
 * screen where every button is denied.
 */
export const OWNER_ROLE_KEY = 'desk-admin';

/**
 * The desk's three SERVICE principals — held by no human, minted once per scope when
 * the platform provisions it (`worker.ts`), and each holding exactly the keys its job
 * needs. `assistantRole` is deliberately absent: which of the two assistant roles a
 * desk hands its AI is the one policy decision this vertical makes out loud, so a
 * hosted desk starts SUPERVISED (`assistant` — drafts, never sends) and an admin
 * upgrades it deliberately rather than by default.
 */
export const SERVICE_ROLES = ['widget', 'assistant', 'relay'] as const;
export type ServiceRole = (typeof SERVICE_ROLES)[number];

/**
 * The roles a PERSON may be invited at, in the order the picker offers them.
 *
 * Listing the humans is the check. `ROLES` above also holds the three service accounts
 * and the two assistant roles, all held by nobody — and offering `widget` in an invite
 * dropdown would be offering to hand somebody the desk's own chat service.
 */
export const HUMAN_ROLES = ['desk-admin', 'agent', 'customer'] as const;

/**
 * Which of those WORK the desk — the ones whose holder belongs in the staff directory
 * and may therefore be assigned a conversation.
 *
 * `customer` is a human role and is deliberately not here: the portal is not the
 * inbox, and a customer turning up in an assignee picker would be a bug rather than a
 * convenience.
 */
export const STAFF_ROLES = ['desk-admin', 'agent'] as const;

/**
 * The one invitable role that takes an argument: a customer's portal is a grant on ONE
 * contact, since `conversation:read-own` is held by nobody scope-wide.
 */
export const CONTACT_BOUND_ROLE = 'customer';

export const permissions = definePermissions({
  modules: MODULES,
  roles: ROLES,
  entityGrants: ENTITY_GRANTS,
});
