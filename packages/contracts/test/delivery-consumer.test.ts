import { expect, it } from 'vitest';
import { deliveryConsumer, executorConsumerId, moduleId, parseExecutorConsumer, type ModuleId, type ExecutorConsumerId } from '../src/index.js';

it('distinguishes module consumers from executor keys without narrowing registered IDs (#1645)', () => {
  expect(deliveryConsumer.parse('@test/consumer')).toBe('@test/consumer');
  for (const id of ['mailer', '', 'multi\nline']) {
    const key = `executor:${id}`;
    expect(deliveryConsumer.parse(key)).toBe(key);
    expect(parseExecutorConsumer(key)).toBe(id);
    expect(moduleId.safeParse(key).success).toBe(false);
  }
  expect(parseExecutorConsumer('@test/consumer')).toBeUndefined();
  expect(deliveryConsumer.safeParse('not:a-consumer').success).toBe(false);
});

// These assertions are checked by tsc: the brands are the contract being fixed.
const executor: ExecutorConsumerId = executorConsumerId.parse('executor:mailer');
// @ts-expect-error an executor consumer is not a module ID
const wrongModule: ModuleId = executor;
const consumer = deliveryConsumer.parse('executor:mailer');
// @ts-expect-error a delivery consumer must be narrowed before using it as a module ID
const uncheckedModule: ModuleId = consumer;
void wrongModule;
void uncheckedModule;
