/**
 * The dev server's stand-in for the platform's `send-email` drain (#3017): a mail a scope queues
 * is written to the outbox folder, named in one line, and settled as sent, as the platform's
 * handler settles it hosted.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EMAIL_SENT,
  SEND_EMAIL_KIND,
  isPlatformRequest,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
} from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { contractTestBareOps } from '@substrat-run/contract-tests';
import { SqliteScopeHost, devMailOutbox } from '../src/index.js';

describe('the dev mail outbox (#3017)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-dev-mail-'));
  const host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)) });
  const staff = platformActorId.parse(ulid());
  const t1 = tenantId.parse(ulid());
  const s1 = scopeId.parse(ulid());
  const node = { tenantId: t1, scopeId: s1 };
  const alice = principalId.parse(ulid());
  const lines: string[] = [];
  const outbox = devMailOutbox(host, { dataDir: dir, actor: staff, log: (line) => lines.push(line) });
  const mail = (subject: string) => ({ to: 'nora@example.com', subject, html: '<p>Hej</p>', text: 'Hej Nora' });

  beforeAll(async () => {
    for (const name of ['platform/request', 'platform/outcome-events']) host.defineOperation(name, contractTestBareOps[name]!);
    await host.admin.createTenant(staff, { id: t1, slug: `dev-mail-${ulid().toLowerCase()}`, name: 'Dev mail' });
    await host.provisionScope(staff, { tenantId: t1, scopeId: s1 });
    await host.admin.activateScope(staff, t1, s1);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('writes a mail an invoke queued, names the file, and settles it as sent', async () => {
    const stub = await host.getScope(alice, t1, s1, outbox.kick(node));
    const about = { entityType: 'invite', entityId: ulid() };
    // Long and not ASCII, so its header is several encoded words, each within RFC 2047's 75.
    const subject = 'Välkommen till säljteamet på Ängsgården, där vi följer upp varje affär';
    const id = await stub.invoke<string>('platform/request', { kind: SEND_EMAIL_KIND, payload: { ...mail(subject), about } });
    // A drain runs after the one the kick started, so by now that one has written and settled.
    expect(await outbox.drain(node)).toEqual([]);

    const file = join(dir, 'outbox', `${id}.eml`);
    expect(lines).toContain(`mail to nora@example.com, "${subject}": ${file}`);
    const eml = readFileSync(file, 'utf8');
    expect(eml).toContain('To: nora@example.com\r\n');
    const words = /\r\nSubject: ((?:=\?UTF-8\?B\?[^?]+\?=(?:\r\n )?)+)\r\n/.exec(eml)![1]!.split('\r\n ');
    expect(words.length).toBeGreaterThan(1);
    expect(words.every((w) => w.length <= 75)).toBe(true);
    const decoded = words.map((w) => Uint8Array.from(atob(w.slice(10, -2)), (c) => c.charCodeAt(0)));
    expect(new TextDecoder().decode(new Uint8Array(decoded.flatMap((b) => [...b])))).toBe(subject);
    expect(eml).toContain('Hej Nora');
    expect(eml).toContain('<p>Hej</p>');

    const settled = (await host.listPlatformRequestHistory(t1, s1)).filter(isPlatformRequest).find((r) => r.id === id);
    expect(settled?.status).toBe('done');
    const events = await stub.invoke<{ type: string; entity_type: string; entity_id: string; payload: string }[]>('platform/outcome-events');
    const mine = events.filter((e) => (JSON.parse(e.payload) as { request: string }).request === id);
    expect(mine.map((e) => [e.type, e.entity_type, e.entity_id])).toEqual([[EMAIL_SENT, 'invite', about.entityId]]);
  });

  it('drains what was queued before it started, and leaves every other intent to the platform', async () => {
    const quiet = await host.getScope(alice, t1, s1);
    const id = await quiet.invoke<string>('platform/request', { kind: SEND_EMAIL_KIND, payload: mail('Påminnelse') });
    const other = await quiet.invoke<string>('platform/request', { kind: 'provision-sibling', payload: { slug: 'padel' } });

    expect(await outbox.drain()).toEqual([join(dir, 'outbox', `${id}.eml`)]);
    expect((await host.listPlatformRequests(t1, s1)).map((r) => r.id)).toEqual([other]);
  });

  it('writes the mail behind one it cannot settle, and says which is still queued', async () => {
    const quiet = await host.getScope(alice, t1, s1);
    const stuck = await quiet.invoke<string>('platform/request', { kind: SEND_EMAIL_KIND, payload: mail('Första') });
    const next = await quiet.invoke<string>('platform/request', { kind: SEND_EMAIL_KIND, payload: mail('Andra') });
    const refusing = devMailOutbox(
      {
        admin: host.admin,
        listPlatformRequests: (t, s) => host.listPlatformRequests(t, s),
        settlePlatformRequest: async (t, s, id, outcome) => {
          if (id === stuck) throw new Error('disk full');
          return host.settlePlatformRequest(t, s, id, outcome);
        },
      },
      { dataDir: dir, actor: staff, log: (line) => lines.push(line) },
    );

    await expect(refusing.drain(node)).rejects.toThrow(`1 mail(s) left queued: ${stuck}`);
    expect(lines).toContain(`mail outbox: could not write ${stuck}: disk full`);
    expect(lines).toContain(`mail to nora@example.com, "Andra": ${join(dir, 'outbox', `${next}.eml`)}`);
    const queued = (await host.listPlatformRequests(t1, s1)).map((r) => r.id).filter((id) => id === stuck || id === next);
    expect(queued).toEqual([stuck]);
    expect(await outbox.drain(node)).toEqual([join(dir, 'outbox', `${stuck}.eml`)]);
  });
});
