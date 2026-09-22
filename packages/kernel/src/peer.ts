/**
 * Peers (#1706) — the kernel's half of one vertical calling another's operations, written once
 * so both adapters (and the platform's resolver) cannot disagree about any of it.
 *
 * What lives here, and why each is one function:
 *
 * - **`collectPeers`** — the union of every registered module's `peers` declaration. A vertical
 *   is several modules on one host; the door reads them as one declaration per peer vertical.
 * - **`peerSeats`** — the `vertical:<slug>` grants provisioning seats on a scope. The ONE place
 *   that decides "a declared peer holds its keys once installed" (decision F2 on #1706): if that
 *   decision flips to "a tenant admin enables each edge", this call moves from provisioning to
 *   the enabling verb and nothing else changes.
 * - **`admitPeer`** — the door's admission, run inside the scope's own serialized task on every
 *   call: the peer is declared, its kill switch is on, and the operation is on its allowlist.
 *   None of those refusals is a K-35 denial (no key was checked), exactly as the capability
 *   door's are. `operation: null` admits a DELIVERY rather than an invocation (#1705's
 *   cross-vertical events) — the same declaration and the same switch, and no allowlist, since
 *   a delivery names no operation.
 * - **`switchPeer`** — the per-(scope, peer) kill switch, which is #1666's switch applied to a
 *   `vertical:` subject (`switchSubjectGrants`): OFF tombstones every grant the peer holds on the
 *   scope and makes an OFF marker live. The checker reads only live `granted:`/`role:` tuples,
 *   so a switched-off peer holds nothing to ANY check — `covers` included — without the checker
 *   knowing the marker exists; and `seatScopeTuple` seats nothing for a subject whose marker is
 *   live, so no re-provision can hand the grants back. `restoreToPeer` is the only way back.
 * - **`resolveVerticalInstanceFrom`** — "the instance of vertical Y in tenant T": one rule for
 *   every directory that is asked.
 *
 * What is deliberately NOT here: who is calling. The door is handed a `VerticalCaller` by the
 * platform (the router on the hosted path, the local broker on the pure host), and trusts it the
 * way `getConnectorScope` trusts the connection id the control plane hands it. The door's own
 * guarantees are the ones above; the caller's liveness and tenancy are the platform's gate.
 */
import {
  substratError,
  type CheckSubject,
  type PeerSpec,
  type Scope,
  type TenantId,
  type VerticalCaller,
  type VerticalResolution,
} from '@substrat-run/contracts';
import { isPrimaryScope } from './platform-sweep.js';
import { subjectSwitchedOff, switchSubjectGrants, type SwitchOutcome, type SwitchSql } from './system-switch.js';

/** The tuple-subject prefix of a peer vertical — `vertical:acme/board-room`. */
export const PEER_SUBJECT_PREFIX = 'vertical:';

/** The tuple subject a peer's grants are seated under. The slug only, never the instance. */
export const peerSubjectRef = (vertical: string): string => `${PEER_SUBJECT_PREFIX}${vertical}`;

/** One peer vertical as every registered module declares it, together. */
export interface PeerDeclaration {
  readonly vertical: string;
  /** The door's allowlist. Empty for a receive-only peer. */
  readonly operations: ReadonlySet<string>;
  /** What `vertical:<slug>` is seated with at provisioning. */
  readonly permissions: ReadonlySet<string>;
}
export type PeerDeclarations = ReadonlyMap<string, PeerDeclaration>;

/**
 * The union of every module's `peers` declaration, keyed by peer slug. Two modules naming one
 * peer contribute both of their allowlists and both of their key sets: each module speaks for
 * its own operations, and a reviewer reads each entry in its own module's permission section.
 */
export function collectPeers(manifests: Iterable<{ peers?: readonly PeerSpec[] }>): Map<string, PeerDeclaration> {
  const out = new Map<string, { vertical: string; operations: Set<string>; permissions: Set<string> }>();
  for (const manifest of manifests) {
    for (const peer of manifest.peers ?? []) {
      const entry = out.get(peer.vertical) ?? {
        vertical: peer.vertical,
        operations: new Set<string>(),
        permissions: new Set<string>(),
      };
      for (const op of peer.operations) entry.operations.add(op);
      for (const p of peer.permissions) entry.permissions.add(p);
      out.set(peer.vertical, entry);
    }
  }
  return out;
}

/** One grant provisioning seats — handed to `seatScopeTuple` by each adapter. */
export interface PeerSeat {
  readonly subject: string;
  readonly relation: string;
  readonly object: string;
}

/**
 * The grants a scope holds for its declared peers: `vertical:<slug>` / `granted:<perm>` /
 * `scope:<id>`, one per declared key, in a stable order. Seated with `seatScopeTuple` — so a
 * grant an operator's switch tombstoned stays tombstoned (#1659), and a peer whose switch is off
 * gets nothing seated at all.
 */
export function peerSeats(peers: PeerDeclarations, scopeId: string): PeerSeat[] {
  const out: PeerSeat[] = [];
  for (const peer of [...peers.values()].sort((a, b) => a.vertical.localeCompare(b.vertical))) {
    for (const permission of [...peer.permissions].sort()) {
      out.push({ subject: peerSubjectRef(peer.vertical), relation: `granted:${permission}`, object: `scope:${scopeId}` });
    }
  }
  return out;
}

/**
 * The door's admission (#1706), run inside the scope's own serialized task on every call, so a
 * switch pulled between two calls refuses the second. Throws `forbidden` — a door refusal, never
 * a K-35 denial: no permission was checked, exactly as for a capability's allowlist. Returns the
 * check subject the operation then runs as, with every ordinary `ctx.check` inside it.
 *
 * `operation: null` is a delivery (#1705), which names no operation and so meets no allowlist.
 */
export function admitPeer(
  db: SwitchSql,
  peers: PeerDeclarations,
  caller: VerticalCaller,
  operation: string | null,
): CheckSubject {
  const declared = peers.get(caller.vertical);
  if (!declared) {
    throw substratError(
      'forbidden',
      `vertical '${caller.vertical}' is not a declared peer of this vertical — a peer is declared in ` +
        `the target's module manifest (\`peers\`), and reviewed in its PERMISSIONS.md`,
    );
  }
  if (subjectSwitchedOff(db, peerSubjectRef(caller.vertical))) {
    throw substratError(
      'forbidden',
      `vertical '${caller.vertical}' is switched off on this scope — restoreToPeer turns it back on`,
    );
  }
  if (operation !== null && !declared.operations.has(operation)) {
    throw substratError(
      'forbidden',
      `vertical '${caller.vertical}' may not invoke '${operation}' — it is not among the operations ` +
        `this vertical's \`peers\` declaration allows it`,
    );
  }
  return { kind: 'vertical', id: caller.vertical, scope: caller.scope };
}

/**
 * Move one peer's kill switch on one scope. Idempotent, and `held: false` with nothing written
 * when the scope holds neither a grant nor a marker for that peer — a typo'd slug, or a peer this
 * scope was never provisioned with, must not write a marker that silently blocks it the day a
 * version declaring it lands. Run inside one transaction.
 */
export function switchPeer(
  db: SwitchSql,
  input: { vertical: string; scopeId: string; to: 'on' | 'off'; at: string },
): SwitchOutcome {
  return switchSubjectGrants(db, {
    subject: peerSubjectRef(input.vertical),
    scopeId: input.scopeId,
    to: input.to,
    at: input.at,
  });
}

/** Is this peer switched off on the scope `db` is? */
export function peerSwitchedOff(db: SwitchSql, vertical: string): boolean {
  return subjectSwitchedOff(db, peerSubjectRef(vertical));
}

/** A directory row, as much of it as the resolution reads. */
export type VerticalInstanceCandidate = Pick<Scope, 'id' | 'tenantId' | 'vertical' | 'status' | 'kind' | 'forkedFrom'>;

/**
 * "The instance of vertical Y in tenant T" (#1706) — the one rule every directory applies.
 *
 * A candidate is a scope of THAT tenant, bound to THAT vertical, primary (`isPrimaryScope`: not a
 * fork, not a preview — a preview must never receive another app's production calls), and
 * `active` (a suspended or archived instance answers nothing). Exactly one → `resolved`; none →
 * `not-installed`; more than one → `ambiguous`, refused rather than guessed.
 *
 * The tenant is a parameter, and it is the ONLY tenant searched: nothing in a caller's request
 * names a tenant, so a cross-tenant answer is not reachable from here.
 */
export function resolveVerticalInstanceFrom(
  scopes: Iterable<VerticalInstanceCandidate>,
  tenantId: TenantId,
  vertical: string,
): VerticalResolution {
  const matches: VerticalInstanceCandidate[] = [];
  for (const scope of scopes) {
    if (scope.tenantId !== tenantId || scope.vertical !== vertical) continue;
    if (scope.status !== 'active' || !isPrimaryScope(scope)) continue;
    matches.push(scope);
  }
  const [only] = matches;
  if (only && matches.length === 1) {
    return { outcome: 'resolved', instance: { tenantId: only.tenantId, scopeId: only.id, vertical } };
  }
  if (matches.length === 0) return { outcome: 'not-installed', tenantId, vertical };
  return { outcome: 'ambiguous', tenantId, vertical, count: matches.length };
}
