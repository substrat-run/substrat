import { describe, expect, it } from 'vitest';
import { parseValidationRecords } from '../src/index.js';

/**
 * The cert-validation records on a hostname row are the only part of that row this
 * platform did not write — they are whatever Cloudflare's custom-hostname API returned,
 * stored verbatim. A bare `JSON.parse` on that column turned one unreadable blob into a
 * `SyntaxError`, which the control-plane's error mapper does not recognise and answers as
 * a blank 500; because the deploy path read hostnames FLEET-WIDE, a cert detail on one
 * domain could stop unrelated verticals from shipping — after their version had already
 * been published.
 *
 * So the contract is: never throw. A row whose records cannot be read still describes a
 * real binding, and only its copy-this-CNAME hint is lost.
 */
describe('parseValidationRecords', () => {
  it('reads the records a normal issuance wrote', () => {
    const records = [{ type: 'CNAME', name: '_acme.crm.example.com', value: 'x.example.net' }];
    expect(parseValidationRecords(JSON.stringify(records))).toEqual(records);
  });

  it('treats an absent column as no records', () => {
    expect(parseValidationRecords(null)).toEqual([]);
    expect(parseValidationRecords(undefined)).toEqual([]);
    expect(parseValidationRecords('')).toEqual([]);
  });

  it('degrades a MALFORMED blob to empty instead of throwing', () => {
    // Truncation is the realistic shape of this — a write cut short, or a value that
    // was never JSON at all.
    expect(parseValidationRecords('[{"type":"CNAME","name":"_acme.crm.exa')).toEqual([]);
    expect(parseValidationRecords('not json at all')).toEqual([]);
    expect(parseValidationRecords('{')).toEqual([]);
  });

  it('degrades a well-formed NON-array to empty', () => {
    // Valid JSON of the wrong shape must not reach the Zod boundary as a non-array and
    // fail there instead — that would just move the same outage one layer along.
    expect(parseValidationRecords('{"type":"CNAME"}')).toEqual([]);
    expect(parseValidationRecords('null')).toEqual([]);
    expect(parseValidationRecords('"CNAME"')).toEqual([]);
    expect(parseValidationRecords('42')).toEqual([]);
  });
});
