/**
 * The capability a vertical-defined connector is handed (docs/architecture/vertical-connectors.md
 * §5.2): one connection's worth of the platform, and nothing that reaches past it. There is no
 * tenant argument, no scope host and no admin. `vertical-host` implements it; the kernel only
 * names the shape, so a connector package depends on the kernel and not on the host.
 */
import type {
  AttachmentRecord,
  ConnectionId,
  ConnectionUseOutcomeWire,
  ScopeId,
  TenantId,
} from '@substrat-run/contracts';
import type { ConnectionUseOutcome } from './connector-calls.js';
import type { OpenedAttachment } from './attachment-bytes.js';
import type { FetchLike } from './connector-transport.js';
import type { AttachmentUploadInput } from './scope-host.js';

/** What a connector's `attachments.upload` takes: the scope's own upload input. */
export type ConnectorUploadInput = AttachmentUploadInput;

export interface ConnectionContext {
  readonly connection: {
    id: ConnectionId;
    provider: string;
    tenantId: TenantId;
    vertical: string;
    externalAccountRef: string | null;
    expiresAt: string | null;
  };
  /** The credential the tenant connected. This connection's, nothing else. */
  readonly secret: Readonly<Record<string, string>>;
  /** Deadline-bound; every call is recorded as a use of this connection (health, §3.7). */
  readonly fetch: FetchLike;
  /** Key/value state kept for this connection (and, on a scoped call, this scope). */
  readonly state: {
    get(key: string): Promise<unknown | undefined>;
    /** `null` deletes. */
    put(key: string, value: unknown | null): Promise<void>;
    list(prefix?: string): Promise<{ key: string; value: unknown }[]>;
  };
}

export interface ScopedConnectionContext extends ConnectionContext {
  readonly scope: {
    tenantId: TenantId;
    scopeId: ScopeId;
    operation: string | null;
    options: Record<string, unknown>;
  };
  /** Invoke the binding's landing operation as the connection principal. */
  land<O = unknown>(input: unknown): Promise<O>;
  /** Invoke any operation as the connection principal; its grants decide. */
  invoke<O = unknown>(operation: string, input?: unknown): Promise<O>;
  readonly attachments: {
    upload(input: ConnectorUploadInput): Promise<AttachmentRecord>;
    open(attachmentId: string): Promise<OpenedAttachment | null>;
  };
}

/**
 * Thrown by a connector to fail terminally: an intent settles `failed`, a probe answers
 * `refused: true`. Any other throw is retried by whoever called it.
 */
export class ConnectorRefusal extends Error {
  readonly refused = true;
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorRefusal';
  }
}

/**
 * A `ConnectorRefusal`, or a plain object marked `refused: true` — a refusal thrown in another
 * realm (a connector package bundled with its own copy of the kernel) fails `instanceof`.
 */
export function isConnectorRefusal(e: unknown): e is { refused: true; message?: string } {
  return e instanceof ConnectorRefusal || (typeof e === 'object' && e !== null && (e as { refused?: unknown }).refused === true);
}

// The wire schema in contracts and the kernel's own type describe one value: a recorded use read
// off a connector's answer is handed to `recordConnectionUse` as is. Fails to compile on drift.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
type _ConnectionUseOutcomeAgrees = Assert<Same<ConnectionUseOutcome, ConnectionUseOutcomeWire>>;
