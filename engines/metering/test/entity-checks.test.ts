/**
 * This engine checks at the node only — assessed under #865, not left silent.
 *
 * Eight node checks over `configure`, `record`, `read` and `close`. Metering
 * counts what a scope consumed: a meter is scope-level configuration, `record`
 * is machine-driven ingest, and a period closes for the scope as a whole. None
 * of those has a per-entity reader — a principal entitled to see one meter's
 * usage and not another's would be a reporting concern in the vertical above,
 * expressed by what it queries, not by narrowing the engine's own checks.
 *
 * See `nodeOnlySuite`'s header for exactly how much this proves. This engine has
 * no declared operation surface for the conformance kit to read; that is filed
 * separately.
 */
import { nodeOnlySuite } from '@substrat-run/contract-tests';

nodeOnlySuite('engine-metering', {
  sources: [new URL('../src/index.ts', import.meta.url).pathname],
});
