import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UNSAFE_allowAllChecker, manualClock, webCryptoSecretBox, type ModuleLogLine, type InvocationLogLine } from '@substrat-run/kernel';
import { defaultAttachmentExtractors } from '@substrat-run/attachment-extractors';
import {
  atomicContractSuite,
  grantExpiryContractSuite,
  facetRecencyContractSuite,
  impersonationContractSuite,
  inertScopeContractSuite,
  membershipExecutorContractSuite,
  capabilityAttachmentContractSuite,
  attachmentTextContractSuite,
  capabilityContractSuite,
  capabilityExpiryContractSuite,
  connectorTestFetch,
  permissionContractSuite,
  scheduleContractSuite,
  scheduleEntitlementContractSuite,
  jobRunContractSuite,
  systemSwitchContractSuite,
  peerContractSuite,
  verticalResolutionContractSuite,
  scopeHostContractSuite,
  searchContractSuite,
  entityVersionContractSuite,
  timelineContractSuite,
  concurrencyContractSuite,
  emittedReportContractSuite,
  moduleLogContractSuite,
  asyncLogContractSuite,
  idempotencyContractSuite,
  listContractSuite,
  inputParseContractSuite,
  entityStateContractSuite,
  spineGuardContractSuite,
  sqlLimitsContractSuite,
} from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';

scopeHostContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-contract-'));
  const host = new SqliteScopeHost({
    dir,
    checker: UNSAFE_allowAllChecker,
    // A fixed key: the contract suite asserts the credential round-trips and
    // never leaks, not that the ciphertext is unpredictable.
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    fetch: connectorTestFetch,
  });
  return {
    host,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

// #2005: a fork or a preview causes no outbound effects. Allow-all, like the scope-host
// suite: what this pins is whether an effect RUNS, not who may ask for one.
inertScopeContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-inert-'));
  const host = new SqliteScopeHost({
    dir,
    checker: UNSAFE_allowAllChecker,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    fetch: connectorTestFetch,
  });
  return {
    host,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

// #1184: the membership executor, on the DEFAULT checker — its bound is a permission-set
// comparison, which an allow-all checker would answer "covered" for everything.
membershipExecutorContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-membership-'));
  const host = new SqliteScopeHost({
    dir,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return {
    host,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

// The permission suite runs against the DEFAULT checker (the tuple engine).
permissionContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-perm-'));
  const host = new SqliteScopeHost({
    dir,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return {
    host,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

// The schedule suite needs the DEFAULT checker too — the whole point is that the
// system grant resolves through the real tuple engine, not an allow-all.
scheduleContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-sched-'));
  const host = new SqliteScopeHost({
    dir,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return {
    host,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

// #1654: a composed engine's own schedule runs without the engine's SKU, and nothing else
// the exception could reach does. The DEFAULT checker, so the user-door case's role is real.
scheduleEntitlementContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-sched-sku-'));
  const host = new SqliteScopeHost({
    dir,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return {
    host,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

// #1577: the resumable-run driver. The DEFAULT checker, for the same reason the
// schedule suite above wants one — a job's steps act through the system door, and
// what they may do has to resolve through the real tuple engine (an explicit
// `grantToSystem`, since this module declares no schedules to project one).
jobRunContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-jobs-'));
  const host = new SqliteScopeHost({
    dir,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return {
    host,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

// #1666: the schedule kill switch. The DEFAULT checker — what the switch stops is a
// system principal's own `ctx.check`, which an allow-all would pass regardless.
systemSwitchContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-switch-'));
  const host = new SqliteScopeHost({
    dir,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return {
    host,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

// #1706: the peer door and the instance resolution. The DEFAULT checker, for the capability
// suite's reason: half of what the door pins is that a peer holds exactly its declared keys,
// and an allow-all checker would make every refusal in it pass for the wrong reason.
const peerFixture = (prefix: string) => async () => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const host = new SqliteScopeHost({
    dir,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return {
    host,
    // #2030: the directory's tenant tuple, as a tenant-level grant writes it. No platform verb
    // grants a peer tenant-wide yet, so the fixture writes the row itself.
    seatTenantGrant: async (tenant: string, subject: string, permission: string) => {
      (host as unknown as { directory: { prepare(q: string): { run(...a: unknown[]): void } } }).directory
        .prepare(
          `INSERT OR REPLACE INTO _substrat_tenant_tuples (tenant_id, subject, relation, object, expires_at)
           VALUES (?, ?, ?, ?, NULL)`,
        )
        .run(tenant, subject, `granted:${permission}`, `tenant:${tenant}`);
    },
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};
peerContractSuite('adapter-sqlite', peerFixture('substrat-peer-'));
verticalResolutionContractSuite('adapter-sqlite', peerFixture('substrat-resolve-'));

// #770: sub-transactions. The DEFAULT checker — the K-34 assertion turns on a real
// `ctx.check` recording an authorization, which an allow-all never does.
atomicContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-atomic-'));
  const host = new SqliteScopeHost({
    dir,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return {
    host,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

// K-42 (#868): acting as a principal with the real actor preserved. The DEFAULT
// tuple checker, not allow-all — half of what this suite pins is that the door
// grants no authority of its own, and an allow-all checker would make the one
// test that proves it (a session against a principal who holds nothing) pass for
// the wrong reason.
// #1672: capabilities — authority carried by a secret. The DEFAULT tuple checker, for the
// reason the impersonation suite gives: half of what it pins is that the door grants no
// authority of its own, and an allow-all checker would make that pass for the wrong reason.
capabilityContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-cap-'));
  const host = new SqliteScopeHost({
    dir,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return {
    host,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

// #1686: attachments through a capability — the same checker branch, reached through the
// attachment surface. The per-tenant blob store is the directory store the suite provisions.
capabilityAttachmentContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-cap-att-'));
  const host = new SqliteScopeHost({
    dir,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    // K-43: the host's parsers, passed in at the composition root.
    attachmentExtractors: defaultAttachmentExtractors(),
  });
  return {
    host,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

// #1575: attachment text — extraction, the FTS5 index and the search gate on node SQLite.
attachmentTextContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-att-text-'));
  const host = new SqliteScopeHost({
    dir,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    // K-43: the host's parsers, passed in at the composition root.
    attachmentExtractors: defaultAttachmentExtractors(),
  });
  return {
    host,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

// #1672: the expiry TRANSITIONS, which need a clock the test can move — pure host only,
// like `grantExpiryContractSuite` (the DO host takes no clock, #956).
capabilityExpiryContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-cap-expiry-'));
  const clock = manualClock();
  const host = new SqliteScopeHost({ dir, clock: clock.read });
  return {
    host,
    clock,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

impersonationContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-imp-'));
  const host = new SqliteScopeHost({
    dir,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return {
    host,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

// #827: the derived FTS index. Allow-all checker — the suite is about what the
// index answers, and the permission gate over a search operation is the
// vertical's own `assertAllowed`, exercised by the demo scenario.
searchContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-search-'));
  const host = new SqliteScopeHost({ dir, checker: UNSAFE_allowAllChecker });
  return {
    host,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

// #901: an entity's version is the last event's ULID. Allow-all checker for the
// same reason as search — the subject is what the spine answers, not the gate
// over the operation asking.
entityVersionContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-version-'));
  const host = new SqliteScopeHost({ dir, checker: UNSAFE_allowAllChecker });
  return {
    host,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

// #800: the supported read of an entity's history. The DEFAULT checker, because
// the history half asserts K-34 `authorization` — the checks the emitting
// operation passed — and an allow-all cannot answer a real `ctx.check` at all
// (it interpolates the subject, which is a structured actor).
timelineContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-timeline-'));
  const host = new SqliteScopeHost({ dir });
  return {
    host,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

// #811: the same shape for `ctx.page`. Permission is likewise not this suite's
// subject — a page is a read, and the operation's own `assertAllowed` gates it.
listContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-list-'));
  const host = new SqliteScopeHost({ dir, checker: UNSAFE_allowAllChecker });
  return {
    host,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

// #119: archive and trash. The DEFAULT checker: what is pinned is that the kernel checks the
// DECLARED key, which an allow-all checker would pass whether it was checked or not.
let stateHost: SqliteScopeHost | undefined;
entityStateContractSuite(
  'adapter-sqlite',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'substrat-state-'));
    const host = new SqliteScopeHost({ dir });
    stateHost = host;
    return {
      host,
      cleanup: async () => {
        await host.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  },
  // The scope's own connection, past `ctx.sql`.
  async (tenant, scope, sql, params = []) => {
    const internals = stateHost as unknown as {
      runtime(t: typeof tenant, s: typeof scope): { db: { prepare(q: string): { run(...a: unknown[]): unknown } } };
    };
    internals.runtime(tenant, scope).db.prepare(sql).run(...params);
  },
);

// #893: the declared `input` is parsed by the HOST, before guards and handler.
// The DEFAULT checker: the fixture's handlers run a real `ctx.check`, and
// allow-all cannot answer one — it builds its synthetic proof by interpolating
// the subject, which is a structured actor.
inputParseContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-parse-'));
  const host = new SqliteScopeHost({ dir });
  return {
    host,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

// #954: the spine guard on ctx.sql. Allow-all checker — the module's forge
// operations check nothing, because what is being pinned is the connection, not
// the permission in front of it.
spineGuardContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-spine-'));
  const host = new SqliteScopeHost({ dir, checker: UNSAFE_allowAllChecker });
  return {
    host,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

// #1741: the SQL limits a Durable Object enforces on ctx.sql — here the pure host enforces
// them itself (`guardSqlLimits`), so a vertical's suite fails where production would.
sqlLimitsContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-sqllimits-'));
  const host = new SqliteScopeHost({ dir, checker: UNSAFE_allowAllChecker });
  return {
    host,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

// #956: a timed grant expires against the HOST's clock. The DEFAULT checker, on a
// manual clock the suite moves — the subject is that the checker's `expires_at`
// judgement reads `options.clock` and not `new Date()`. Mounted here and not on the
// Cloudflare adapter: the DO reads the wall clock and no option reaches it (the
// suite header says why), so a mount there would be a fact the adapter cannot show.
grantExpiryContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-expiry-'));
  const clock = manualClock();
  const host = new SqliteScopeHost({ dir, clock: clock.read });
  return {
    host,
    clock,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

// #1234: a facet bucket's `lastSeen` is the LATEST event in it. Mounted here and not
// on the Cloudflare adapter for the same reason as the suite above: the DO stamps
// `occurred_at` from a clock no host option reaches, and without control of time MIN
// and MAX return the same string. The suite header carries the full argument.
facetRecencyContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-recency-'));
  const clock = manualClock();
  const host = new SqliteScopeHost({ dir, clock: clock.read });
  return {
    host,
    clock,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

// #129: optimistic concurrency, on the DEFAULT checker. The suite grants a real
// role, because a precondition that only ever runs behind an allow-all has not
// been shown to run in the order the contract claims — before the guards, and
// after the permission check that would otherwise have refused the caller first.
concurrencyContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-conc-'));
  const host = new SqliteScopeHost({ dir });
  return {
    host,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

// #116: request idempotency, on the DEFAULT checker for the same reason the
// suite above uses one — a recording written behind an allow-all has not been
// shown to be written after the permission check that guards it.
idempotencyContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-idem-'));
  const host = new SqliteScopeHost({ dir });
  return {
    host,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

// #1746: the per-request record's scope half — what an invocation itself emitted, and which
// kind of subject its stub acts as.
emittedReportContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-emitted-'));
  const host = new SqliteScopeHost({ dir });
  return {
    host,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

// #1901: async work's invocation lines, read off both sinks a deployment leaves at the console.
asyncLogContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-asynclog-'));
  const lines: InvocationLogLine[] = [];
  const logs: ModuleLogLine[] = [];
  const host = new SqliteScopeHost({
    dir,
    logSink: (line) => logs.push(line),
    invocationLineSink: (line) => lines.push(line),
  });
  return {
    host,
    lines: () => lines,
    logs: () => logs,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

// #1746/#1747: ctx.log — what the host stamps on a module's line. The sink is the host
// option a deployment leaves at its console default.
moduleLogContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-log-'));
  const lines: ModuleLogLine[] = [];
  const host = new SqliteScopeHost({ dir, logSink: (line) => lines.push(line) });
  return {
    host,
    logs: () => lines,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});
