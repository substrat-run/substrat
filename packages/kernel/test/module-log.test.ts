import { describe, expect, it } from 'vitest';
import { MODULE_LOG_LIMITS, moduleLog, moduleLogLine, renderTemplate, type ModuleLogLine } from '../src/module-log.js';
import { WITHHELD_SECRET, redactSecretText, redactSecrets } from '../src/capability.js';

/** #1746/#1747: the rules `ctx.log` applies to what module code hands it. */
const ctx = {
  tenantId: 'T1',
  scopeId: 'S1',
  operation: 'acme/reply',
  invocationId: () => 'INV1',
  principalKind: 'principal',
};

describe('ctx.log', () => {
  it('fills placeholders from fields and leaves a missing one visible', () => {
    expect(renderTemplate('reply to {id} by {who}', { id: 't1' })).toBe('reply to t1 by {who}');
    expect(renderTemplate('{n} items, ok={ok}', { n: 3, ok: false })).toBe('3 items, ok=false');
  });

  it('stamps what the host knows, and keeps the template verbatim', () => {
    expect(moduleLogLine(ctx, 'warn', 'reply to {id} bounced', { id: 't1' })).toEqual({
      substrat: 'log',
      level: 'warn',
      template: 'reply to {id} bounced',
      message: 'reply to t1 bounced',
      fields: { id: 't1' },
      tenantId: 'T1',
      scopeId: 'S1',
      operation: 'acme/reply',
      invocationId: 'INV1',
      principalKind: 'principal',
    });
  });

  it('drops a key it would not index, stringifies a non-primitive, and bounds everything', () => {
    const line = moduleLogLine(ctx, 'info', 'x'.repeat(2000), {
      'a.b': 1,
      ok: { nested: true },
      missing: undefined,
      long: 'y'.repeat(5000),
    });
    expect(line.fields).toEqual({ ok: '{"nested":true}', missing: null, long: expect.any(String) });
    expect((line.fields['long'] as string).length).toBe(MODULE_LOG_LIMITS.value);
    expect(line.template.length).toBe(MODULE_LOG_LIMITS.template);
    const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}`, i]));
    expect(Object.keys(moduleLogLine(ctx, 'info', 't', many).fields)).toHaveLength(MODULE_LOG_LIMITS.fields);
  });

  it('withholds a secret wherever it appears', () => {
    const redact = (t: string) => t.split('sekret').join('[withheld]');
    const line = moduleLogLine({ ...ctx, redact }, 'info', 'minted {token} (sekret)', { token: 'sekret' });
    expect(JSON.stringify(line)).not.toContain('sekret');
    expect(line.message).toBe('minted [withheld] ([withheld])');
  });

  it('keeps the line, secret withheld, with the redaction the adapters wire in', () => {
    // The object redaction parses its serialization back, so it throws on plain text —
    // which is why a log line needs the string twin. Pinned so nobody swaps them back.
    expect(() => redactSecrets('minted sekret', ['sekret'])).toThrow();
    const lines: ModuleLogLine[] = [];
    const log = moduleLog({ ...ctx, redact: (t) => redactSecretText(t, ['sekret']) }, (l) => lines.push(l));
    log.info('minted {token}', { token: 'sekret' });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.message).toBe(`minted ${WITHHELD_SECRET}`);
    expect(JSON.stringify(lines[0])).not.toContain('sekret');
  });

  it('redacts before it clips, so a secret straddling a limit is never written in part', () => {
    const secret = 'sbcap_' + 'A'.repeat(43);
    const redact = (t: string) => redactSecretText(t, [secret]);
    // The secret starts just inside each limit and would be cut one character short.
    const field = 'x'.repeat(MODULE_LOG_LIMITS.value - secret.length + 1) + secret + 'y';
    const template = 't'.repeat(MODULE_LOG_LIMITS.template - secret.length + 1) + secret + '{v}';
    const line = moduleLogLine({ ...ctx, redact }, 'info', template, { v: field });
    const text = JSON.stringify(line);
    // Not the whole secret, and no part a clip could have left behind either.
    expect(text).not.toContain(secret.slice(0, 12));
    expect((line.fields['v'] as string).length).toBeLessThanOrEqual(MODULE_LOG_LIMITS.value);
    expect(line.template.length).toBeLessThanOrEqual(MODULE_LOG_LIMITS.template);
  });

  it('never throws — not for a bad template, bad fields, or a sink that fails', () => {
    const lines: ModuleLogLine[] = [];
    const log = moduleLog(ctx, (l) => lines.push(l));
    // Wrong types reach here from untyped callers; the line is still written.
    log.info(42 as unknown as string, 'nope' as unknown as Record<string, string>);
    expect(lines[0]).toMatchObject({ template: '42', fields: {} });
    const failing = moduleLog(ctx, () => {
      throw new Error('sink down');
    });
    expect(() => failing.error('boom')).not.toThrow();
  });

  it('reads the invocation id at each call, not when the logger was built', () => {
    let current: string | null = null;
    const lines: ModuleLogLine[] = [];
    const log = moduleLog({ ...ctx, invocationId: () => current }, (l) => lines.push(l));
    log.info('first');
    current = 'INV2';
    log.info('second');
    expect(lines.map((l) => l.invocationId)).toEqual([null, 'INV2']);
  });
});
