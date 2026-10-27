import { describe, expect, it } from 'vitest';
import type { OperationContext } from '@substrat-run/kernel';

type EventStamp = { type: string; schemaVersion: number };
type EmittedEvent = EventStamp & { piiClass?: string; subjectId?: string };

/** Keep the shipped event list independent of the manifest and the emitter. */
export function eventVersionSuite<Type extends string>({
  engine,
  shipped,
  manifest,
  versions,
  emit,
  assertEmitted,
}: {
  engine: string;
  shipped: readonly EventStamp[];
  manifest: { events: { emits: readonly EventStamp[] } };
  versions: Record<Type, number>;
  emit: (ctx: OperationContext, type: Type) => void;
  assertEmitted?: (events: readonly EmittedEvent[]) => void;
}): void {
  describe(`${engine}: event schemaVersion has one home`, () => {
    it('the manifest emits exactly what shipped, in the same order', () => {
      expect(manifest.events.emits).toEqual(shipped);
    });

    it('every emission carries the version the manifest declares for its type', () => {
      const seen: EmittedEvent[] = [];
      const ctx = { emit: (event: EmittedEvent) => void seen.push(event) } as unknown as OperationContext;
      for (const type of Object.keys(versions) as Type[]) emit(ctx, type);
      expect(seen.map(({ type, schemaVersion }) => ({ type, schemaVersion }))).toEqual(
        manifest.events.emits.map(({ type, schemaVersion }) => ({ type, schemaVersion })),
      );
      assertEmitted?.(seen);
    });
  });
}

export function handlerBindingSuite(
  engine: string,
  module: { operations?: { handlers?: Record<string, unknown> } },
  operations: Record<string, unknown>,
): void {
  describe(`#959 engine-${engine} handler binding`, () => {
    it('registers exactly one handler per declared operation', () => {
      expect(Object.keys(module.operations?.handlers ?? {}).sort()).toEqual(Object.keys(operations).sort());
    });
  });
}
