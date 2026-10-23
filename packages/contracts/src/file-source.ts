import { z } from 'zod';
import { attachmentRecord } from './attachments.js';
import { entityRef } from './events.js';

/**
 * File-source vocabulary (#2499): what a vertical sees of a provider that holds files, whichever
 * provider it is.
 *
 * A file source is a connector whose far side is a tree of files rather than a set of records
 * (#1578, `docs/architecture/connections.md` §6.3). Two shapes cross to the vertical, and both are
 * here so a vertical codes against these names and a second provider lands on the same words:
 *
 * - {@link fileSourceChange} — the change a sync lands through the vertical's own operation, one
 *   per invoke;
 * - {@link fileSourceWriteRequest} — the payload of the event a vertical emits to put files in the
 *   bound folder.
 *
 * The event TYPE a write travels under is the provider's, never named here: it is what routes the
 * delivery to that provider's connector, so a neutral type could not say which provider to run.
 *
 * Every file source holds the same four invariants, and these shapes carry them:
 *
 * - **Nothing outside the fence is persisted.** A change names an item inside the bound folder or
 *   an item that was, never one that is outside it. A `delete` with reason `moved-out` carries the
 *   item's prior path and name, and never where it went.
 * - **The conflict mode is explicit.** A write names `replace`, `rename` or `fail`
 *   ({@link fileSourceConflict}); there is no default, and the provider never picks.
 * - **Delivery is at least once, keyed by `itemId`.** A landing operation upserts by the item's id
 *   and may see the same change twice.
 * - **A delete lands only on an answer about that item.** Never from a deleted parent, the held
 *   tree, or a re-read's silence.
 *
 * What is NOT here, by decision: the `FileSource` facet and the job-run bridge wait for a second
 * file-bearing provider, so they are extracted from two implementations rather than one.
 */

/** The most files one write request may carry. */
export const FILE_SOURCE_MAX_FILES_PER_WRITE = 20;
/** The largest file either direction moves. A bigger one is refused on write, and lands without bytes on read. */
export const FILE_SOURCE_MAX_FILE_BYTES = 50 * 1024 * 1024;
/**
 * The most bytes one write request may move, all its files together. A dispatch holds one file at
 * a time, so this bounds how long a delivery runs, not its memory; the per-file cap bounds that.
 */
export const FILE_SOURCE_MAX_WRITE_BYTES = 100 * 1024 * 1024;

/** What a write does when the name is taken. Said in the request, never defaulted. */
export const fileSourceConflict = z.enum(['replace', 'rename', 'fail']);
export type FileSourceConflict = z.infer<typeof fileSourceConflict>;

/**
 * The payload of the event a vertical emits to write files into its bound folder, as the provider's
 * connector reads it. A vertical builds it with this schema; the dispatch parses it again with the
 * same one.
 *
 * `conflict` is required: what happens when the name is taken is the vertical's choice, said in the
 * request, never a default. The attachments must belong to the entity the event names — the
 * delivery is the authority to read them, so no standing grant is needed and none is consulted.
 *
 * Each file states its `size` (the attachment record's), so the caps are checked before a byte is
 * read. The dispatch refuses a file whose attachment turns out to be another size — but only once
 * it is read, since `openAttachment` hands over the bytes whole and says nothing first; a dishonest
 * declaration costs its own delivery one oversized read, and is refused there.
 */
export const fileSourceWriteRequest = z.object({
  /** The folder under the bound folder to write into; `''` (the default) is the bound folder itself. */
  directory: z.string().default(''),
  files: z
    .array(
      z.object({
        attachmentId: z.string().min(1),
        /** The file's name at the source. Defaults to the attachment's filename. */
        name: z.string().min(1).optional(),
        /** The attachment's size in bytes, as its record states it. */
        size: z.number().int().nonnegative().max(FILE_SOURCE_MAX_FILE_BYTES),
      }),
    )
    .min(1)
    .max(FILE_SOURCE_MAX_FILES_PER_WRITE)
    .refine((files) => files.reduce((n, f) => n + f.size, 0) <= FILE_SOURCE_MAX_WRITE_BYTES, {
      message: `the files come to more than ${FILE_SOURCE_MAX_WRITE_BYTES} bytes, the most one event may move`,
    })
    // The ledger records progress by attachment, so one attachment named twice would be written
    // once and reported done. Two copies of one attachment are two events.
    .refine((files) => new Set(files.map((f) => f.attachmentId)).size === files.length, {
      message: 'an attachment is named more than once',
    }),
  conflict: fileSourceConflict,
});
/** What a vertical builds: `directory` may be left out. */
export type FileSourceWriteRequest = z.input<typeof fileSourceWriteRequest>;

const commonChange = {
  connectionId: z.string().min(1),
  /** The item's id at the source — the stable key. A path changes on a rename; this does not. */
  itemId: z.string().min(1),
  kind: z.enum(['file', 'folder']),
  /** Relative to the bound folder, `/`-joined. */
  path: z.string().min(1),
  name: z.string().min(1),
};

/**
 * What a sync lands through the binding's operation, one change per invoke — parsed with this
 * schema on the way out, so a vertical compiled against one version of a connector gets a throw
 * rather than a reshaped change from another.
 *
 * - `upsert`: the item exists in the folder, new or changed. `previousPath` is set when it moved or
 *   was renamed. For a file, `content` says whether bytes follow: `follows` means the operation
 *   should answer `{ entity }`, the attachment target the bytes land on, and a `content` change
 *   comes next. `unchanged` means only metadata moved; `too-large` means the file is over
 *   {@link FILE_SOURCE_MAX_FILE_BYTES}, or the source did not state its size, and its bytes are not
 *   brought in.
 * - `content`: the bytes landed as `attachment` on the entity the upsert named. `replaces` is the
 *   attachment the previous content landed as, if any — the vertical decides whether to keep it.
 * - `delete`: the item is gone from the folder — `deleted` at the source, or `moved-out` of the
 *   folder (where it went is not said: outside the folder is not the binding's to report). Every
 *   delete is on that item's own answer, so a folder's delete says nothing about what was in it: an
 *   item still held under it gets a delete of its own, or none — a vertical must not cascade.
 *
 * Delivery is **at least once**, keyed by `itemId`: a vertical's operation upserts by `itemId`, and
 * may see an upsert, or a `content`, twice.
 */
export const fileSourceChange = z.discriminatedUnion('change', [
  z.object({
    change: z.literal('upsert'),
    ...commonChange,
    previousPath: z.string().nullable(),
    size: z.number().int().nonnegative().nullable(),
    contentType: z.string().nullable(),
    lastModifiedAt: z.string().nullable(),
    webUrl: z.string().nullable(),
    content: z.enum(['follows', 'unchanged', 'too-large']).nullable(),
  }),
  z.object({
    change: z.literal('content'),
    ...commonChange,
    attachment: attachmentRecord.pick({ id: true, filename: true, contentType: true, size: true, sha256: true }),
    replaces: z.string().nullable(),
  }),
  z.object({
    change: z.literal('delete'),
    ...commonChange,
    reason: z.enum(['deleted', 'moved-out']),
  }),
]);
export type FileSourceChange = z.infer<typeof fileSourceChange>;

/**
 * What the landing operation answers to an upsert whose content follows: the entity the bytes
 * attach to. Anything else is read as "no bytes". Parsed by the connector, not by the vertical, so
 * an answer carrying more than `entity` is accepted and the rest ignored.
 */
export const fileSourceUpsertAnswer = z.object({ entity: entityRef.nullable().optional() }).passthrough();
export type FileSourceUpsertAnswer = z.infer<typeof fileSourceUpsertAnswer>;
