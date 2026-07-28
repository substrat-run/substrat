export { calloutModule } from './module.js';
export { calloutManifest, SC_PERM } from './manifest.js';
// Protocol machinery lives in the engine since milestone B; re-exported here
// for the scenario test's convenience.
export {
  PROTOCOL_PERM as PROTO_PERM,
  protocolContentHash,
  requireSigned,
  type ProtocolDetail,
  type ProtocolInstanceRow,
  type ProtocolSignatureRow,
  type ProtocolSummary,
  type ProtocolTemplateRow,
} from '@substrat-run/engine-protocol';
export {
  buildDemoHost,
  seedDemo,
  provisionCallout,
  type CalloutInstance,
  type DemoWorld,
} from './seed.js';
