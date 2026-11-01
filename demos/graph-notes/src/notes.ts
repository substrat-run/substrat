/**
 * What a caller does with notes: each action invokes its operation (the permission check), then
 * calls the scope store through the host's door, `getScopeStore`.
 *
 * The store call is not inside the operation's transaction. A refused check never reaches the
 * store; a store that fails after the check answers as a `StoreError`, with the store's own code
 * in `storeCode`.
 *
 * Every store call names a session. Each action opens a fresh one, at the notes' level and with
 * the notes part as its schema and data part (`putScope`), and makes its calls in it. A session
 * the store dropped (it expires a session that holds only settings after a day idle, and refuses
 * the id after that) is then never asked for again.
 */
import { substratError, z, type PrincipalId, type ScopeId, type TenantId } from '@substrat-run/contracts';
import { ulid, type ScopeHost, type StoreStub } from '@substrat-run/kernel';
import { GRAPH_BINDING } from './manifest.js';
import {
  attributeUri,
  CREATE_NOTE,
  NOTE_ATTRIBUTES,
  NOTE_TYPE,
  NOTES_LEVEL,
  NOTES_PART,
  PART_ID,
  PART_URI,
  PART_VERSION,
  type NoteAttribute,
} from './spec.js';

/** Who is asking, and where: the triple every door takes. */
export interface Caller {
  readonly principal: PrincipalId;
  readonly tenantId: TenantId;
  readonly scopeId: ScopeId;
}

export const noteInput = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(10_000).optional(),
});
export type NoteInput = z.input<typeof noteInput>;

export const notesPageInput = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
});
export type NotesPageInput = z.input<typeof notesPageInput>;

const storedNote = z.object({ uri: z.string().min(1), title: z.string(), body: z.string().nullish() });
export interface Note {
  readonly uri: string;
  readonly title: string;
  readonly body: string | null;
}
export interface NotesPage {
  readonly notes: Note[];
  readonly total: number;
  readonly nextCursor: string | null;
}

const installed = z.object({ ok: z.literal(true), parts: z.array(z.object({ alreadyInstalled: z.boolean() })).length(1) });
const storeIssue = z.object({
  code: z.string(),
  message: z.string(),
  field: z.string().nullish(),
  relatedUri: z.string().nullish(),
});
const batch = z.object({
  outcome: z.string(),
  commands: z.array(z.object({ uri: z.string().nullish() })),
  issues: z.array(storeIssue),
});
const page = z.object({ items: z.array(storedNote), totalCount: z.number().int(), nextCursor: z.string().nullable() });

const noteOf = (row: z.infer<typeof storedNote>): Note => ({ uri: row.uri, title: row.title, body: row.body ?? null });

/** An issue's path is the note attribute it names, when it names one. */
function issuePath(issue: z.infer<typeof storeIssue>): string {
  const named = (Object.keys(NOTE_ATTRIBUTES) as NoteAttribute[]).find((name) => attributeUri(name) === issue.relatedUri);
  return named ?? issue.field ?? '';
}

export function graphNotes(host: Pick<ScopeHost, 'getScope' | 'getScopeStore'>) {
  /** The check, then the store. */
  async function admitted(caller: Caller, operation: string): Promise<StoreStub> {
    const scope = await host.getScope(caller.principal, caller.tenantId, caller.scopeId);
    await scope.invoke(operation);
    return host.getScopeStore(caller.principal, caller.tenantId, caller.scopeId, GRAPH_BINDING);
  }

  /** A fresh session at the notes' level, with the notes part to read and write. */
  async function notesSession(store: StoreStub): Promise<string> {
    const session = ulid();
    await store.invoke('putScope', {
      session,
      level: NOTES_LEVEL,
      sessionVariables: { 'package-management': { schemaParts: [PART_URI], dataParts: [PART_URI] } },
    });
    return session;
  }

  return {
    /** Upload and install the notes part. Again is a no-op: `alreadyInstalled` says which. */
    async installSchema(caller: Caller): Promise<{ alreadyInstalled: boolean }> {
      const store = await admitted(caller, 'graph-notes/install-schema');
      const session = ulid();
      await store.invoke('putPackageUpload', { session, partId: PART_ID, version: PART_VERSION, document: NOTES_PART });
      const answer = installed.parse(
        await store.invoke('postPackageInstallation', {
          session,
          formatVersion: 3,
          parts: [{ id: PART_ID, version: PART_VERSION, level: NOTES_LEVEL, rebindings: [] }],
        }),
      );
      return { alreadyInstalled: answer.parts[0]!.alreadyInstalled };
    },

    /** Write one note. A note the store finds invalid is refused with its issues. */
    async createNote(caller: Caller, input: NoteInput): Promise<Note> {
      const note = noteInput.parse(input);
      const store = await admitted(caller, 'graph-notes/create-note');
      const session = await notesSession(store);
      const answer = batch.parse(
        await store.invoke('postDataBatch', {
          session,
          commands: [{ op: CREATE_NOTE, localRef: 'note', title: note.title, ...(note.body === undefined ? {} : { body: note.body }) }],
          options: { mode: 'apply' },
        }),
      );
      const uri = answer.commands[0]?.uri;
      if (answer.outcome !== 'committed' || !uri) {
        throw substratError('validation_failed', `the graph store did not commit the note (${answer.outcome})`, {
          errors: answer.issues.map((issue) => ({ path: issuePath(issue), message: `${issue.code}: ${issue.message}` })),
        });
      }
      return { uri, title: note.title, body: note.body ?? null };
    },

    /** One page of notes, in the store's order. The next page starts `after` the cursor the last one gave. */
    async listNotes(caller: Caller, input: NotesPageInput = {}): Promise<NotesPage> {
      const { limit, cursor } = notesPageInput.parse(input);
      const store = await admitted(caller, 'graph-notes/read-notes');
      const session = await notesSession(store);
      const answer = page.parse(
        await store.invoke('listDataInstances', { session, type: NOTE_TYPE, limit, ...(cursor === undefined ? {} : { after: cursor }) }),
      );
      return { notes: answer.items.map(noteOf), total: answer.totalCount, nextCursor: answer.nextCursor };
    },

    /** One note by its URI. An unknown URI is the store's 404 (`storeCode` `data.resource-not-found`). */
    async readNote(caller: Caller, uri: string): Promise<Note> {
      const store = await admitted(caller, 'graph-notes/read-notes');
      const session = await notesSession(store);
      return noteOf(storedNote.parse(await store.invoke('getDataInstance', { session, type: NOTE_TYPE, uri })));
    },
  };
}
