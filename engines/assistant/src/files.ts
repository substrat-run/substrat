/**
 * HOST code, separate from the in-scope engine. Bind `caller` to the authenticated
 * person and `storage` to the assistant host's system principal, in the SAME scope.
 * Never expose `storage` itself to a browser or model tool.
 */
import { substratError, uploadLinkFilename, type AttachmentRecord } from '@substrat-run/contracts';
import type { OpenedAttachment, ScopeAttachments, ScopeStub } from '@substrat-run/kernel';
import type { Thread } from './shapes.js';

export const ASSISTANT_FILE_MAX_BYTES = 10 * 1024 * 1024;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface AssistantFileUpload {
  threadId: string;
  filename: string;
  body: Uint8Array;
}

/** A browser need not guess a spreadsheet's MIME type; the supported suffix fixes it. */
function contentType(filename: string): string {
  const dot = filename.lastIndexOf('.');
  const extension = dot < 0 ? '' : filename.slice(dot + 1).toLowerCase();
  if (extension === 'xlsx') return XLSX;
  if (extension === 'csv') return 'text/csv';
  if (extension === 'tsv') return 'text/tab-separated-values';
  throw substratError('validation_failed', 'upload a .csv, .tsv or .xlsx file; save older Excel files as .xlsx first');
}

/**
 * A host mounts these methods on its own authenticated routes. Bytes bypass invoke;
 * ownership and audit checks go through the engine's real operation handlers.
 * There is intentionally no automatic import: the host's tools preview a diff and
 * use the existing approval/claim flow before changing domain entities.
 */
export function assistantFiles(caller: ScopeStub, storage: ScopeAttachments) {
  const entity = (threadId: string) => ({ entityType: 'assistant-thread', entityId: threadId });

  const list = async (threadId: string): Promise<AttachmentRecord[]> => {
    await caller.invoke<Thread>('assistant/get-thread', { threadId });
    return storage.list(entity(threadId));
  };

  return {
    async upload(input: AssistantFileUpload): Promise<AttachmentRecord> {
      const filename = uploadLinkFilename.parse(input.filename);
      const type = contentType(filename);
      if (!input.body.byteLength || input.body.byteLength > ASSISTANT_FILE_MAX_BYTES) {
        throw substratError('validation_failed', `a file must contain between 1 and ${ASSISTANT_FILE_MAX_BYTES} bytes`);
      }
      await caller.invoke<Thread>('assistant/authorize-file-upload', { threadId: input.threadId });
      return storage.upload({
        entity: entity(input.threadId), filename, contentType: type, body: input.body, visibility: 'internal',
      });
    },
    list,
    async open(threadId: string, attachmentId: string): Promise<OpenedAttachment> {
      // Authorize and match the id BEFORE opening any bytes with the host's key.
      const record = (await list(threadId)).find((file) => file.id === attachmentId);
      if (!record) throw substratError('not_found', `file not found in thread: ${attachmentId}`);
      const opened = await storage.open(attachmentId);
      if (!opened) throw substratError('not_found', `file not found in thread: ${attachmentId}`);
      return opened;
    },
  };
}

/**
 * Trusted host lifecycle hook: remove blobs BEFORE erasing a thread's owner. The
 * kernel's subject erasure deletes engine rows, but does not shred attachment blobs.
 * Repeatable; failed blob deletions follow the platform's orphan-sweep policy.
 * Do not expose as an unauthenticated route.
 */
export async function purgeAssistantThreadFiles(storage: ScopeAttachments, threadId: string): Promise<void> {
  for (const file of await storage.list({ entityType: 'assistant-thread', entityId: threadId })) {
    await storage.remove(file.id);
  }
}
