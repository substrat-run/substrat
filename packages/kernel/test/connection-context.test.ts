import { describe, expect, it } from 'vitest';
import { ConnectorRefusal, isConnectorRefusal } from '../src/index.js';

describe('isConnectorRefusal', () => {
  it.each([
    [new ConnectorRefusal('credential rejected'), true],
    // A refusal thrown by another copy of the kernel fails `instanceof`; its mark still reads.
    [{ refused: true, message: 'credential rejected' }, true],
    [new Error('timeout'), false],
    [{ refused: 'yes' }, false],
    [null, false],
  ])('%o → %s', (e, expected) => {
    expect(isConnectorRefusal(e)).toBe(expected);
  });
});
