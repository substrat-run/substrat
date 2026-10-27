import { expect } from 'vitest';
import { eventVersionSuite } from '@substrat-run/engine-test-kit/suites';
import { assistantEventVersions, emitAssistantEvent } from '../src/events.js';
import { assistantManifest } from '../src/index.js';

const SHIPPED = [
  { type: 'assistant.thread-created', schemaVersion: 1 },
  { type: 'assistant.turn-started', schemaVersion: 1 },
  { type: 'assistant.turn-finished', schemaVersion: 1 },
  { type: 'assistant.approval-requested', schemaVersion: 1 },
  { type: 'assistant.approval-resolved', schemaVersion: 1 },
  { type: 'assistant.thread-closed', schemaVersion: 1 },
];

const subject = '01J00000000000000000000000';

eventVersionSuite({
  engine: 'assistant',
  shipped: SHIPPED,
  manifest: assistantManifest,
  versions: assistantEventVersions,
  emit: (ctx, type) => emitAssistantEvent(ctx, subject, { type, entity: { entityType: 'x', entityId: 'y' }, payload: {} } as never),
  assertEmitted: (events) => expect(events.every((e) => e.piiClass === 'pseudonymous' && e.subjectId === subject)).toBe(true),
});
