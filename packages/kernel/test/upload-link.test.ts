/**
 * The two pure decisions an upload link makes before any scope is involved: which media types
 * a link's allowlist admits, and which strings could be a secret the kernel minted. Both run
 * in the route AND in the kernel's redemption, so one rule is what both halves enforce.
 */
import { describe, expect, it } from 'vitest';
import { UPLOAD_LINK_SECRET_PREFIX, isUploadLinkSecretShape } from '@substrat-run/contracts';
import {
  ACTIVE_CONTENT_TYPES,
  isActiveContentType,
  isMediaTypeEssence,
  normalizeUploadMediaType,
  uploadContentTypeAllowed,
} from '../src/index.js';
import { mintUploadLinkSecret } from '../src/upload-link.js';

describe('uploadContentTypeAllowed', () => {
  const policy = ['application/pdf', 'text/*', 'image/*'];

  it('a family admits its ordinary members, and an exact entry admits itself', () => {
    expect(uploadContentTypeAllowed(policy, 'image/png')).toBe(true);
    expect(uploadContentTypeAllowed(policy, 'IMAGE/PNG')).toBe(true);
    expect(uploadContentTypeAllowed(policy, 'text/plain')).toBe(true);
    expect(uploadContentTypeAllowed(policy, 'application/pdf')).toBe(true);
    expect(uploadContentTypeAllowed(policy, 'application/zip')).toBe(false);
  });

  it('a family never admits an active type — a browser would run it — whichever family would contain it', () => {
    for (const active of ACTIVE_CONTENT_TYPES) {
      const family = `${active.split('/')[0]}/*`;
      expect(uploadContentTypeAllowed([family], active), active).toBe(false);
    }
    expect(uploadContentTypeAllowed(policy, 'image/svg+xml')).toBe(false);
    expect(uploadContentTypeAllowed(policy, 'text/html')).toBe(false);
    expect(uploadContentTypeAllowed(policy, 'Text/HTML')).toBe(false);
  });

  it('an exact entry admits an active type on purpose; an absent allowlist admits everything, active types too', () => {
    for (const active of ACTIVE_CONTENT_TYPES) {
      expect(uploadContentTypeAllowed([...policy, active], active), active).toBe(true);
      expect(uploadContentTypeAllowed(null, active), active).toBe(true);
    }
  });

  it('names the types a reviewer would expect, and only lowercase ones (the comparison lowercases the request)', () => {
    expect([...ACTIVE_CONTENT_TYPES]).toEqual(
      expect.arrayContaining(['image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/javascript', 'text/xml']),
    );
    for (const t of ACTIVE_CONTENT_TYPES) expect(t).toBe(t.toLowerCase());
  });

  /** WHATWG MIME Sniffing §4.6: every JavaScript MIME type essence. */
  const JAVASCRIPT_ESSENCES = [
    'application/ecmascript',
    'application/javascript',
    'application/x-ecmascript',
    'application/x-javascript',
    'text/ecmascript',
    'text/javascript',
    'text/javascript1.0',
    'text/javascript1.1',
    'text/javascript1.2',
    'text/javascript1.3',
    'text/javascript1.4',
    'text/javascript1.5',
    'text/jscript',
    'text/livescript',
    'text/x-ecmascript',
    'text/x-javascript',
  ];
  const families = ['image/*', 'text/*', 'application/*'];

  it('every JavaScript MIME essence is active, and no family admits one; an exact entry does', () => {
    for (const js of JAVASCRIPT_ESSENCES) {
      expect(isActiveContentType(js), js).toBe(true);
      expect(uploadContentTypeAllowed(families, js), js).toBe(false);
      expect(uploadContentTypeAllowed([...families, js], js), js).toBe(true);
    }
  });

  it('every XML type is active by rule, not by list — any +xml subtype, under any family; an exact entry admits it', () => {
    for (const xml of ['image/foo+xml', 'text/foo+xml', 'application/rss+xml', 'application/atom+xml', 'application/vnd.wap.xhtml+xml']) {
      expect(ACTIVE_CONTENT_TYPES.has(xml), xml).toBe(false); // held by the rule, not the list
      expect(isActiveContentType(xml), xml).toBe(true);
      expect(uploadContentTypeAllowed(families, xml), xml).toBe(false);
      expect(uploadContentTypeAllowed([...families, xml], xml), xml).toBe(true);
    }
  });

  it('the types a browser sniffs for HTML, or parses as HTML, are active: text/xsl and the unknown essences', () => {
    for (const t of ['text/xsl', 'application/unknown', 'unknown/unknown']) {
      expect(isActiveContentType(t), t).toBe(true);
      expect(uploadContentTypeAllowed(['text/*', 'application/*', 'unknown/*'], t), t).toBe(false);
      expect(uploadContentTypeAllowed([t], t), t).toBe(true);
    }
    // The near misses Chrome renders as text stay ordinary.
    for (const t of ['text/xslt', 'text/x-xsl', 'text/css', 'text/vtt', 'text/plain']) {
      expect(isActiveContentType(t), t).toBe(false);
      expect(uploadContentTypeAllowed(['text/*'], t), t).toBe(true);
    }
  });

  it('its twin: ordinary members of every family stay admitted — the rule is not "refuse everything"', () => {
    for (const ok of ['image/png', 'image/jpeg', 'text/plain', 'text/csv', 'application/json', 'application/zip', 'application/pdf']) {
      expect(isActiveContentType(ok), ok).toBe(false);
      expect(uploadContentTypeAllowed(families, ok), ok).toBe(true);
    }
    // A type that merely mentions xml is not one.
    expect(isActiveContentType('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(false);
    expect(isActiveContentType('application/xml-dtd')).toBe(false);
  });
});

describe('a type that is not exactly one essence is admitted by nothing', () => {
  /** A list, a control character, a missing or extra part: none is one `type/subtype`. */
  const MALFORMED = [
  'a/b,c/d',
  // One slash, then a comma or whitespace: Chrome reads each as the type before it.
  'text/html,x',
  'text/html x',
  'text/html\tx',
  'image/png,x',
  // A wildcard in either part is an allowlist's word, never a file's type.
  '*/*',
  'image/*',
  '*/png',
  'image/png,application/xhtml+xml,*/*',
  'image/png, text/html',
  'image/svg+xml,*/*',
  'image/png\0',
  'image/svg+xml\0',
  'image/png\rx',
  'image/png\nx',
  'image/svg+xml\r\nx: y',
  'image/',
  '/png',
  'image/png/extra',
  'image png',
  'image',
  '',
];

  it('refuses each under every family, under an exact entry it resembles, and under an absent allowlist', () => {
    for (const t of MALFORMED) {
      const label = JSON.stringify(t);
      expect(isMediaTypeEssence(normalizeUploadMediaType(t)), label).toBe(false);
      expect(uploadContentTypeAllowed(['image/*', 'text/*', 'application/*', '*/*'], t), label).toBe(false);
      expect(uploadContentTypeAllowed(['image/png', 'image/svg+xml', 'a/b'], t), label).toBe(false);
      expect(uploadContentTypeAllowed(null, t), label).toBe(false);
    }
  });

  it('its twin: a well-formed essence, every RFC 9110 token character but `*` included, is judged as before', () => {
    for (const t of ['image/png', 'application/vnd.ms-excel', 'application/x-www-form-urlencoded', "a!#$%&'+.^_`|~-/b0"]) {
      expect(isMediaTypeEssence(t), t).toBe(true);
      expect(uploadContentTypeAllowed(null, t), t).toBe(true);
    }
    expect(uploadContentTypeAllowed(['image/*'], 'image/png')).toBe(true);
    // A trailing line break is whitespace, trimmed like any other — the essence left is clean.
    expect(uploadContentTypeAllowed(['image/*'], 'image/png\r\n')).toBe(true);
    expect(normalizeUploadMediaType('image/png\r\n')).toBe('image/png');
  });

  it('image/jpg is judged as image/jpeg, so an exact entry spelled image/jpg can never match', () => {
    expect(uploadContentTypeAllowed(['image/jpeg'], 'image/jpg')).toBe(true);
    expect(uploadContentTypeAllowed(['image/jpg'], 'image/jpg')).toBe(false);
  });
});

describe('normalizeUploadMediaType — the one spelling both halves judge', () => {
  it('keeps the essence: parameters dropped, whitespace trimmed, lowercased, image/jpg as image/jpeg', () => {
    expect(normalizeUploadMediaType('image/svg+xml; charset=utf-8')).toBe('image/svg+xml');
    expect(normalizeUploadMediaType('image/svg+xml ')).toBe('image/svg+xml');
    expect(normalizeUploadMediaType('  Image/SVG+XML ;x=1')).toBe('image/svg+xml');
    expect(normalizeUploadMediaType('image/jpg')).toBe('image/jpeg');
    expect(normalizeUploadMediaType('text/plain')).toBe('text/plain');
  });

  it('a type is judged normalized, so a parameter, a space or a capital never slips an active type past a family', () => {
    for (const spelled of [
      'image/svg+xml; charset=utf-8',
      'image/svg+xml ',
      ' image/svg+xml',
      'IMAGE/SVG+XML',
      'Text/HTML; charset=utf-8',
      'text/javascript;x=1',
      'image/foo+xml ; a=b',
    ]) {
      expect(uploadContentTypeAllowed(['image/*', 'text/*'], spelled), JSON.stringify(spelled)).toBe(false);
    }
    // The twins: an exact entry matches its own essence however it is spelled, and an ordinary type passes.
    expect(uploadContentTypeAllowed(['image/svg+xml'], 'Image/SVG+XML; charset=utf-8')).toBe(true);
    expect(uploadContentTypeAllowed(['image/*'], 'image/png; q=1 ')).toBe(true);
    expect(uploadContentTypeAllowed(['application/pdf'], ' Application/PDF ')).toBe(true);
  });
});

describe('isUploadLinkSecretShape', () => {
  it('admits every secret the kernel mints', () => {
    for (let i = 0; i < 50; i++) {
      const secret = mintUploadLinkSecret();
      expect(secret.startsWith(UPLOAD_LINK_SECRET_PREFIX)).toBe(true);
      expect(isUploadLinkSecretShape(secret), secret).toBe(true);
    }
  });

  it('refuses anything the kernel cannot have minted', () => {
    for (const s of [
      '',
      'sbup_',
      'sbup_' + 'A'.repeat(42),
      'sbup_' + 'A'.repeat(44),
      'sbup_' + '+'.repeat(43),
      'sbup_' + 'A'.repeat(42) + '=',
      'SBUP_' + 'A'.repeat(43),
      'sbcap_' + 'A'.repeat(43),
      ' sbup_' + 'A'.repeat(43),
      'sbup_' + 'A'.repeat(43) + '\n',
      'x'.repeat(500),
      undefined,
      42,
    ]) {
      expect(isUploadLinkSecretShape(s), JSON.stringify(s)).toBe(false);
    }
  });
});
