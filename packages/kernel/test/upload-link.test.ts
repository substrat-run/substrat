/**
 * The two pure decisions an upload link makes before any scope is involved: which media types
 * a link's allowlist admits, and which strings could be a secret the kernel minted. Both run
 * in the route AND in the kernel's redemption, so one rule is what both halves enforce.
 */
import { describe, expect, it } from 'vitest';
import { UPLOAD_LINK_SECRET_PREFIX, isUploadLinkSecretShape } from '@substrat-run/contracts';
import { ACTIVE_CONTENT_TYPES, uploadContentTypeAllowed } from '../src/index.js';
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
