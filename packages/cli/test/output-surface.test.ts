import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readDeclaredOutputSurface } from '../src/push.js';

/**
 * What each operation declares it RETURNS (#1321), read off the emitted
 * `openapi.json` so the platform can answer "is this declared field named by
 * anything at all" — a question the manifest could not reach before, because
 * `openapi.json` is built inside each vertical and never sent.
 */
describe('readDeclaredOutputSurface (#1321)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-surface-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (doc: unknown) => writeFileSync(join(dir, 'openapi.json'), JSON.stringify(doc));

  it('takes an object response’s properties, and a list response’s ENTRY properties', () => {
    write({
      paths: {
        '/api/tickets/{id}': {
          get: {
            operationId: 'get-ticket',
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: { type: 'object', properties: { id: {}, subject: {}, state: {} } },
                  },
                },
              },
            },
          },
        },
        '/api/tickets': {
          get: {
            operationId: 'list-tickets',
            responses: {
              '200': {
                content: {
                  'application/json': {
                    // A paged read declares an array; the envelope is the transport's,
                    // and the fields worth counting are the entry's.
                    schema: { type: 'array', items: { type: 'object', properties: { id: {}, subject: {} } } },
                  },
                },
              },
            },
          },
        },
      },
    });
    const surface = readDeclaredOutputSurface(dir)!;
    expect(surface).toHaveLength(2);
    expect(surface.find((o) => o.operationId === 'get-ticket')!.fields).toEqual(['id', 'subject', 'state']);
    expect(surface.find((o) => o.operationId === 'list-tickets')!.fields).toEqual(['id', 'subject']);
  });

  it('reads a 201 like a 200, and omits an operation that declares no fields', () => {
    write({
      paths: {
        '/api/tickets': {
          post: {
            operationId: 'create-ticket',
            responses: {
              '201': { content: { 'application/json': { schema: { type: 'object', properties: { id: {} } } } } },
            },
          },
          delete: {
            operationId: 'delete-ticket',
            // A 204 declares no body: contributing nothing beats an empty row, so
            // "absent" means the same thing everywhere in the surface.
            responses: { '204': {} },
          },
        },
      },
    });
    const surface = readDeclaredOutputSurface(dir)!;
    expect(surface.map((o) => o.operationId)).toEqual(['create-ticket']);
  });

  it('is absent, never fatal, when there is no document or it is malformed', () => {
    // An observability surface must not cost a release: unlike model.json, a broken
    // openapi.json is skipped rather than refusing the push.
    expect(readDeclaredOutputSurface(dir)).toBeUndefined();
    writeFileSync(join(dir, 'openapi.json'), '{ not json');
    expect(readDeclaredOutputSurface(dir)).toBeUndefined();
    write({ info: { title: 'no paths here' } });
    expect(readDeclaredOutputSurface(dir)).toBeUndefined();
  });

  it('derives a real surface from a real emitted document (ticket0)', () => {
    // The fixture is the checked-in artifact `pnpm lint:api` gates, so this fails if
    // the emitter's response shape ever moves out from under the reader.
    const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const doc = readFileSync(join(repo, 'demos', 'ticket0', 'openapi.json'), 'utf8');
    writeFileSync(join(dir, 'openapi.json'), doc);
    const surface = readDeclaredOutputSurface(dir)!;
    expect(surface.length).toBeGreaterThan(10);
    // Every row carries at least one field by construction, and ids are ubiquitous.
    expect(surface.every((o) => o.fields.length > 0)).toBe(true);
    expect(surface.some((o) => o.fields.includes('id'))).toBe(true);
    // A list read contributed its entry's fields, not `entries`/`nextCursor`.
    expect(surface.some((o) => o.fields.includes('nextCursor'))).toBe(false);
  });
});
