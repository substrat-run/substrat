/**
 * ticket0's OpenAPI document — derived, not authored.
 *
 * `apiCatalogFrom` reads the summaries and the input/output schemas off the declared
 * operations, so the document and the handlers cannot disagree: they are the same
 * objects. Served live at `/openapi.json`; the checked-in `openapi.json` is the
 * reviewable artifact that `pnpm lint:api --check` holds against drift.
 */
import { apiCatalogFrom, buildOpenApiDocument } from '@substrat-run/contracts';
import { ticket0Operations } from '../spec/model.js';
import { ticket0Manifest } from './manifest.js';

export const API = apiCatalogFrom(ticket0Operations, {
  'ticket0/get-desk': { tag: 'Desk' },
  'ticket0/configure-desk': { tag: 'Desk' },
  'ticket0/rotate-verification-secret': {
    tag: 'Desk',
    description: 'Returns the secret once. Rotating invalidates every signature the host site is producing.',
  },
  'ticket0/set-agent-profile': { tag: 'Desk', description: 'Your own profile only — the principal comes from the caller.' },

  'ticket0/add-kb-source': { tag: 'Knowledge base' },
  'ticket0/list-kb-sources': { tag: 'Knowledge base' },
  'ticket0/ingest-kb-source': { tag: 'Knowledge base', description: 'Records the intent and emits; a connector does the fetching.' },
  'ticket0/record-kb-articles': { tag: 'Knowledge base', description: 'Idempotent on content hash — an unchanged page writes nothing.' },
  'ticket0/search-kb': { tag: 'Knowledge base', description: 'Ranked and capped, not paged.' },

  'ticket0/list-contacts': { tag: 'Contacts' },

  'ticket0/list-conversations': { tag: 'Inbox' },
  'ticket0/get-conversation': { tag: 'Inbox' },
  'ticket0/list-messages': { tag: 'Inbox', description: 'Staff view — internal notes included.' },
  'ticket0/post-note': { tag: 'Inbox', description: 'Internal. Checks `conversation:draft`.' },
  'ticket0/post-public-reply': {
    tag: 'Inbox',
    description: 'Checks `conversation:reply-public` — the key that decides whether the assistant may answer.',
  },
  'ticket0/assign': { tag: 'Inbox' },
  'ticket0/snooze': { tag: 'Inbox' },
  'ticket0/wake': { tag: 'Inbox' },
  'ticket0/resolve': { tag: 'Inbox', description: 'Refused until something has been sent to the customer.' },
  'ticket0/close': { tag: 'Inbox' },
  'ticket0/merge': { tag: 'Inbox', description: 'Checked on both conversations, not just the loser.' },
  'ticket0/tag-conversation': { tag: 'Inbox' },

  'ticket0/list-saved-replies': { tag: 'Saved replies' },
  'ticket0/create-saved-reply': { tag: 'Saved replies' },

  'ticket0/list-turns': {
    tag: 'Assistant',
    description:
      'What the assistant produced here, for the human deciding whether to send it. Carries no token counts — cost has one door, and it is `usage:read`.',
  },
  'ticket0/record-answer': {
    tag: 'Assistant',
    description: 'The draft and its token usage in one transaction; `turnId` dedupes a retry.',
  },

  'ticket0/usage-summary': { tag: 'Usage', description: 'Checks `usage:read` — held by the desk admin alone.' },
  'ticket0/set-usage-rate': { tag: 'Usage' },
  'ticket0/close-usage-period': { tag: 'Usage', description: 'Freezes the window into immutable lines.' },

  'ticket0/ingest-message': { tag: 'Relay', description: 'Idempotent on the provider message id.' },
  'ticket0/read-outbound': { tag: 'Relay', description: 'The body the event could not carry, read at send time.' },
  'ticket0/record-delivery': { tag: 'Relay' },

  'ticket0/widget-start': { tag: 'Widget', description: 'Anonymous, or verified by an HMAC the host site’s server computed.' },
  'ticket0/widget-post': { tag: 'Widget' },
  'ticket0/widget-thread': { tag: 'Widget', description: 'Public messages only — a separate read, never a flag.' },

  'ticket0/my-conversations': { tag: 'Portal', description: 'A proof walk, never a filter on contact id.' },
  'ticket0/my-messages': { tag: 'Portal' },
  'ticket0/submit-csat': { tag: 'Portal' },

  'ticket0/my-notifications': { tag: 'Notifications' },
  'ticket0/mark-notification-read': { tag: 'Notifications' },
});

export const API_DOCUMENT = buildOpenApiDocument(
  {
    title: 'ticket0',
    version: ticket0Manifest.version,
    description: 'An AI-assisted support desk on Substrat.',
  },
  API,
);
