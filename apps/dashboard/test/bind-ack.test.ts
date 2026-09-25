import { describe, expect, it } from 'vitest';
import { BIND_EXPORT_BREAK_REFUSAL, bindExportBreakRefusal } from '@substrat-run/kernel';
import { BIND_EXPORT_BREAK, bindExportBreakOf, sendWithExportBreakAck } from '../web/src/lib/bind-ack.js';

/**
 * The export-break acknowledgement on Update and Bind (#1756). The flag is the answer to a
 * refusal somebody read: never sent first, sent once after a yes, and never sent to answer a
 * refusal of something else.
 */
describe('sendWithExportBreakAck', () => {
  // The sentence the plane actually sends, from the kernel that writes it, as the dashboard
  // worker relays it (behind whatever prefix the relay adds).
  const refusal = bindExportBreakRefusal([
    { tenantId: 't', scopeId: 's', vertical: 'acme/desk', version: 'v', type: 'ledger.entry-made', schemaVersion: 1, incoming: null },
  ]);

  it('reads the prefix the kernel writes, so a reworded refusal cannot silently stop being recognised', () => {
    expect(BIND_EXPORT_BREAK).toBe(BIND_EXPORT_BREAK_REFUSAL);
    expect(bindExportBreakOf(`409: ${refusal}`)).toBe(refusal);
    expect(bindExportBreakOf('version v is pending, not admitted — it cannot be bound to a scope')).toBeNull();
  });

  it('sends unacknowledged first, and asks nothing when that lands', async () => {
    const sent: boolean[] = [];
    let asked = 0;
    const r = await sendWithExportBreakAck(
      async (ack) => (sent.push(ack), 'ok'),
      () => (asked++, true),
    );
    expect(r).toBe('ok');
    expect(sent).toEqual([false]);
    expect(asked).toBe(0);
  });

  it('on the refusal asks once with its sentence, then sends acknowledged', async () => {
    const sent: boolean[] = [];
    const shown: string[] = [];
    const r = await sendWithExportBreakAck(
      async (ack) => {
        sent.push(ack);
        if (!ack) throw new Error(`409: ${refusal}`);
        return 'bound';
      },
      (said) => (shown.push(said), true),
    );
    expect(r).toBe('bound');
    expect(sent).toEqual([false, true]);
    expect(shown).toEqual([refusal]);
  });

  it('a no sends nothing more', async () => {
    const sent: boolean[] = [];
    const r = await sendWithExportBreakAck(
      async (ack) => {
        sent.push(ack);
        throw new Error(refusal);
      },
      () => false,
    );
    expect(r).toBe('cancelled');
    expect(sent).toEqual([false]);
  });

  it('any other failure is thrown as it is, without asking and without the flag', async () => {
    const sent: boolean[] = [];
    let asked = 0;
    await expect(
      sendWithExportBreakAck(
        async (ack) => {
          sent.push(ack);
          throw new Error('version v is pending, not admitted');
        },
        () => (asked++, true),
      ),
    ).rejects.toThrow(/not admitted/);
    expect(sent).toEqual([false]);
    expect(asked).toBe(0);
  });

  it('a refusal of the acknowledged send is thrown, not asked about again', async () => {
    let asked = 0;
    await expect(
      sendWithExportBreakAck(
        async () => {
          throw new Error(refusal);
        },
        () => (asked++, true),
      ),
    ).rejects.toThrow(BIND_EXPORT_BREAK_REFUSAL);
    expect(asked).toBe(1);
  });
});
