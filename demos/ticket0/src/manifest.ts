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
} from '@substrat-run/contracts';
import { ticket0Entities, ticket0Operations } from '../spec/model.js';

export const T0_PERM = {
  conversationRead: permissionKey.parse('conversation:read'),
  conversationWidget: permissionKey.parse('conversation:widget'),
  conversationReadOwn: permissionKey.parse('conversation:read-own'),
  conversationReplyOwn: permissionKey.parse('conversation:reply-own'),
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

export const ticket0Manifest = moduleManifest.parse({
  id: '@substrat-run/demo-ticket0',
  version: '0.1.0',
  kernelContract: '^0.0.1',
  migrations: { journalDir: './migrations', compatibleFrom: '0.1.0' },
  ...manifestOperations(ticket0Operations, {
    permissions: {
      'conversation:read': 'See every conversation in this desk, internal notes included',
      'conversation:widget': 'Serve the embedded chat widget — held by the desk’s widget service alone; a visitor is confined by their session token, not by this key',
      'conversation:read-own': 'See a conversation that is yours, public messages only',
      'conversation:reply-own': 'Add to a conversation that is yours',
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
});
