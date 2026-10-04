import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertAttachmentBindingFree } from '../src/push.js';
import { built, pushed, pushJs, pushRun, STORES, vertical } from './push-harness.js';

/**
 * The attachment store a push declares (#1995), driven through the real `push()`
 * (./push-harness.ts). A module declaring an attachment target IS the request for a
 * per-tenant bucket: the push carries the need, the control plane mints and binds the bucket
 * for every installed tenant, and the host resolves it — so no vertical hand-maintains
 * `runtimeNeeds.blobStores`, which every deployed one had forgotten.
 */
const TARGET = { entityType: 'ticket', readPermission: 'helpdesk:read' };

describe.runIf(built)('push declares the attachment store from attachmentTargets (#1995)', () => {
  it('a vertical whose module declares a target ships the ATTACHMENTS blob store, undeclared by hand', () => {
    expect(pushed(vertical([{ id: 'helpdesk', attachmentTargets: [TARGET] }])).blobStores).toEqual([
      { binding: 'ATTACHMENTS', kind: 'blob' },
    ]);
  });

  it('a target on ANY composed module counts — an engine’s, not only the vertical’s own', () => {
    const m = pushed(
      vertical([{ id: '@substrat-run/engine-workorder', attachmentTargets: [TARGET] }, { id: 'helpdesk', attachmentTargets: [] }]),
    );
    expect(m.blobStores).toEqual([{ binding: 'ATTACHMENTS', kind: 'blob' }]);
  });

  it('twin: a vertical that attaches nothing ships no blob store at all', () => {
    expect(pushed(vertical([{ id: 'helpdesk', attachmentTargets: [] }])).blobStores).toEqual([]);
  });

  it('keeps a hand-declared blob store beside it', () => {
    const own = pushed(
      vertical([{ id: 'helpdesk', attachmentTargets: [TARGET] }], STORES, { needs: { blobStores: [{ binding: 'FILES' }] } }),
    );
    expect(own.blobStores).toEqual([
      { binding: 'FILES', kind: 'blob' },
      { binding: 'ATTACHMENTS', kind: 'blob' },
    ]);
  });

  it('keeps a hand-declared ATTACHMENTS blob store once', () => {
    const twice = pushed(
      vertical([{ id: 'helpdesk', attachmentTargets: [TARGET] }], STORES, { needs: { blobStores: [{ binding: 'ATTACHMENTS' }] } }),
    );
    expect(twice.blobStores).toEqual([{ binding: 'ATTACHMENTS', kind: 'blob' }]);
  });

  // Each refusal is checked before anything is uploaded: a non-zero exit and no manifest part.
  it('refuses ATTACHMENTS declared as a per-tenant relational store', () => {
    const r = pushRun(
      vertical([{ id: 'helpdesk', attachmentTargets: [TARGET] }], STORES, {
        needs: { tenantStores: [{ binding: 'ATTACHMENTS' }] },
      }),
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/runtimeNeeds\.tenantStores declares 'ATTACHMENTS'/);
    expect(r.stdout).not.toMatch(/^MANIFEST /m);
  });

  it('refuses ATTACHMENTS taken by one of the vertical’s own bindings', () => {
    const r = pushRun(
      vertical([{ id: 'helpdesk', attachmentTargets: [TARGET] }], [...STORES, { binding: 'ATTACHMENTS', class: 'FilesDO' }]),
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/its own binding 'ATTACHMENTS' takes that name/);
    expect(r.stdout).not.toMatch(/^MANIFEST /m);
  });

  it('refuses a hand-declared ATTACHMENTS blob store of another kind — never deduped', () => {
    const r = pushRun(
      vertical([{ id: 'helpdesk', attachmentTargets: [TARGET] }], STORES, {
        needs: { blobStores: [{ binding: 'ATTACHMENTS', kind: 'relational' }] },
      }),
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/"blob"/);
    expect(r.stdout).not.toMatch(/^MANIFEST /m);
  });
});

/**
 * The deployed demos that declare attachment targets get the store from the same derivation —
 * neither hand-declares it, and neither wires a bucket in its worker. Read off the real
 * vertical, as the push reads it (a child process, for the reason push-harness.ts gives).
 */
describe.runIf(built)('the deployed demos that attach declare the store through the push (#1995)', () => {
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  const SURFACE = `
const [pushJs, dir] = process.argv.slice(2);
const { deriveDeclaredSurface } = await import(pushJs);
process.stdout.write('ATTACHES ' + (await deriveDeclaredSurface(dir)).declaresAttachments + '\\n');
`;
  const attaches = (dir: string): string => {
    const runner = join(mkdtempSync(join(tmpdir(), 'substrat-cli-attaches-')), 'run.mjs');
    writeFileSync(runner, SURFACE);
    const r = spawnSync(process.execPath, [runner, pushJs, dir], { cwd: repo, encoding: 'utf8' });
    const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('ATTACHES '));
    if (r.status !== 0 || !line) throw new Error(`surface not derived (${r.status}):\n${r.stdout}\n${r.stderr}`);
    return line.slice('ATTACHES '.length);
  };

  // A real vertical is bundled to be read, which takes longer than a fixture under a full run.
  const BUNDLE_TIMEOUT = 30_000;

  it.each(['demos/meridian', 'demos/callout'])('%s', (dir) => {
    expect(attaches(dir)).toBe('true');
  }, BUNDLE_TIMEOUT);

  it('twin: ticket0 attaches nothing, so its push declares no store', () => {
    expect(attaches('demos/ticket0')).toBe('false');
  }, BUNDLE_TIMEOUT);
});

describe('assertAttachmentBindingFree — an own binding may not take the attachment store’s names (#1995)', () => {
  const declared = [{ binding: 'ATTACHMENTS' }];

  it.each(['ATTACHMENTS', 'ATTACHMENTS__01JTESTATTACHTENANT000000A', 'ATTACHMENTS__ANYTHING'])('refuses %s', (name) => {
    expect(() => assertAttachmentBindingFree([{ name: 'SCOPE' }, { name }], declared)).toThrow(/takes that name/);
  });

  it('allows names that only resemble it, and anything when no attachment store is declared', () => {
    expect(() => assertAttachmentBindingFree([{ name: 'ATTACHMENTS_INDEX' }, { name: 'MY_ATTACHMENTS' }], declared)).not.toThrow();
    expect(() => assertAttachmentBindingFree([{ name: 'ATTACHMENTS' }], [{ binding: 'FILES' }])).not.toThrow();
  });
});
