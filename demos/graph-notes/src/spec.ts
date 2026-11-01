/**
 * The graph store's schema for this vertical: one synthetic part with one type, `Note`, and
 * two text attributes, `title` (required) and `body`.
 *
 * The store starts empty, and nothing on the platform seeds it, so the vertical installs this
 * part itself (`graph-notes/install` in `notes.ts`). Uploading and installing the same part
 * version again is a no-op on the store's side, which is what makes the install idempotent.
 *
 * The URIs are placeholders under `id.example.org`: the part is synthetic and names nothing
 * real.
 */

const PACKAGED_ELEMENT = 'https://id.ontomate.dev/ontoparts/ontomate/package-management/entity/packaged-element';

export const PART_ID = 'example/graph-notes/notes';
export const PART_VERSION = '1.0.0';
/** The part as the store names it in a session's `schemaParts` and `dataParts`. */
export const PART_URI = `https://id.ontomate.dev/ontoparts/ontomate/package-management/part/${PART_ID}`;
/** The level the part is installed at, and the level every call reads and writes at. */
export const NOTES_LEVEL = 1;

export const NOTE_TYPE = 'Note';
/** The data operation the store derives for creating a `Note`. */
export const CREATE_NOTE = 'createNote';

const BASE = 'https://id.example.org/graph-notes/';
const NOTE_URI = `${BASE}entity/note`;

/** The note's attributes, by name: the store's text datatype and the least number of values. */
export const NOTE_ATTRIBUTES = { title: 1, body: 0 } as const;
export type NoteAttribute = keyof typeof NOTE_ATTRIBUTES;

export const attributeUri = (name: NoteAttribute): string => `${BASE}attribute/${name}`;

function attribute(name: NoteAttribute) {
  return {
    uri: attributeUri(name),
    declaredType: PACKAGED_ELEMENT,
    facet: {
      attribute: {
        canonicalName: name,
        description: null,
        owner: NOTE_URI,
        valueType: { literal: 'text' },
        structure: 'single',
        literalCardinality: { minimum: NOTE_ATTRIBUTES[name], maximum: 1 },
        rwdRestriction: null,
      },
    },
  };
}

export const NOTES_PART = {
  formatVersion: 3,
  id: PART_ID,
  version: PART_VERSION,
  dependencies: [PACKAGED_ELEMENT],
  declarations: {
    resources: [
      {
        uri: NOTE_URI,
        declaredType: PACKAGED_ELEMENT,
        facet: {
          entity: {
            canonicalName: NOTE_TYPE,
            description: null,
            abstract: false,
            rwde: { read: 0, write: 0, delete: 0, extend: 0 },
            providerRoles: [],
            superEntity: PACKAGED_ELEMENT,
            allowedOwnerTypes: [],
            allowedRelatedTypesPair: [],
            requiredStructuralBase: null,
          },
        },
      },
      attribute('title'),
      attribute('body'),
    ],
    literalGroups: [],
    logicalEdges: [],
  },
} as const;
